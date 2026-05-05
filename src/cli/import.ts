/**
 * `afd360 import --org <alias> --out ./imported`
 *
 * Reads Connection resources from an existing org and emits a TypeScript
 * manifest + a seeded state file so `afd360 diff` reports noop on the
 * imported resources.
 *
 * Read-only against the org; writes only to disk. Credentials and connection
 * parameters are emitted as `${env.X}` placeholders — afd360 never reads
 * live secret values, and the rendered manifest never carries them. The
 * user fills in a `.env` before the first `afd360 deploy`.
 *
 * v1 scope: Connection (+ ConnectionSchema for IngestApi). That's the
 * resource where auth/secrets round-trip awkwardly and where a scaffold is
 * genuinely useful. DataStream / DMO / Mapping / CalculatedInsight /
 * SearchIndex are deferred — their shapes round-trip poorly and would emit
 * half-baked scaffolds. We'd rather ship a small thing that works than a
 * wide thing full of TODO comments.
 */
import { Command } from "commander";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import pc from "picocolors";
import { getSession } from "../client/auth.js";
import { createClient } from "../client/factory.js";
import type { Data360Client } from "data-360-sdk";
import { normalizeLogicalId, detectCollisions, shouldSkip } from "./import-normalize.js";
import type { StackState, StateResource } from "../core/state.js";
import { hashProps } from "../core/hash.js";

export function registerImport(program: Command): void {
  program
    .command("import")
    .description("Scaffold an afd360 manifest from an existing org (Connection only; v1)")
    .requiredOption("-o, --org <alias>", "sf CLI org alias")
    .option("-O, --out <dir>", "output directory", "./imported")
    .option("-s, --stack <name>", "stack name in the generated manifest", "Imported")
    .option("--preserve-names", "skip logical-id normalization")
    .option("--include-ssot", "include ssot__* / platform-namespaced resources (default: skipped)")
    .action(async (opts: {
      org: string;
      out: string;
      stack: string;
      preserveNames?: boolean;
      includeSsot?: boolean;
    }) => {
      const session = await getSession(opts.org);
      const client = createClient(session);

      process.stdout.write(`${pc.bold("import")} ${opts.org} → ${opts.out}\n`);

      const importer = new Importer(client, {
        preserveNames: !!opts.preserveNames,
        includeSsot: !!opts.includeSsot,
      });
      const snapshot = await importer.run();

      if (!opts.preserveNames) {
        const collisions = detectCollisions(snapshot.entries.map((e) => e.apiName));
        if (collisions.size > 0) {
          process.stderr.write(
            `${pc.red("error:")} ${collisions.size} logical-id collision${collisions.size === 1 ? "" : "s"} during normalization:\n`,
          );
          for (const [logical, apiNames] of collisions) {
            process.stderr.write(`  ${logical} ← ${apiNames.join(", ")}\n`);
          }
          process.stderr.write(
            `re-run with --preserve-names to skip normalization and use api names as logical ids.\n`,
          );
          process.exit(2);
        }
      }

      const manifestPath = join(opts.out, "afd360.config.ts");
      const statePath = join(opts.out, ".afd360/state", `${opts.org}.json`);

      const manifestBody = renderManifest(snapshot, {
        stack: opts.stack,
        org: opts.org,
        normalizations: importer.normalizations,
      });
      await mkdir(dirname(manifestPath), { recursive: true });
      await writeFile(manifestPath, manifestBody, "utf8");

      const state = buildStateFile(snapshot, opts.stack, opts.org);
      await mkdir(dirname(statePath), { recursive: true });
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

      process.stdout.write(
        `${pc.green("done")}  ${snapshot.entries.length} resource${snapshot.entries.length === 1 ? "" : "s"} → ${manifestPath}\n`,
      );
      if (importer.normalizations.length > 0) {
        process.stdout.write(
          `       ${importer.normalizations.length} name${importer.normalizations.length === 1 ? "" : "s"} normalized (see comment at top of manifest)\n`,
        );
      }
      process.stdout.write(
        `       ${statePath} (seeded; next \`afd360 diff\` should report noop)\n`,
      );
    });
}

// ── Importer ────────────────────────────────────────────────────────────────

interface ConnectionEntry {
  readonly kind: "Connection";
  readonly logicalId: string;
  readonly apiName: string;
  readonly salesforceId: string;
  readonly connectorType: string;
  readonly label: string;
  /** Present for IngestApi connections. Materialized inline as `schema:` prop. */
  readonly schema?: ConnectionSchemaSketch;
}

interface ConnectionSchemaSketch {
  readonly schemaName: string;
  readonly label: string;
  // Field shapes come from listSchema; we pass through the minimum afd360
  // needs to re-create the schema identically.
  readonly fields: ReadonlyArray<{ name: string; dataType: string; isPrimaryKey?: boolean }>;
}

interface Snapshot {
  readonly entries: ConnectionEntry[];
}

interface NormalizationNote {
  readonly kind: string;
  readonly from: string;
  readonly to: string;
}

interface ImportOptions {
  readonly preserveNames: boolean;
  readonly includeSsot: boolean;
}

class Importer {
  readonly normalizations: NormalizationNote[] = [];
  constructor(
    private readonly client: Data360Client,
    private readonly opts: ImportOptions,
  ) {}

  async run(): Promise<Snapshot> {
    const entries: ConnectionEntry[] = [];
    // Walk the connector types v1 knows how to model. Others would need
    // per-family credential mapping we haven't wired yet.
    const types = ["AwsS3", "IngestApi", "Snowflake", "AzureBlob", "Databricks"];
    for (const connectorType of types) {
      let list: { connections?: Array<{ id?: string; name?: string; label?: string; connectorType?: string }> };
      try {
        list = (await this.client.connections.list({
          connectorType,
          batchSize: 200,
        })) as never;
      } catch {
        // Connector family not licensed / not accessible — skip silently.
        continue;
      }
      for (const c of list.connections ?? []) {
        if (!c.name || !c.id) continue;
        if (!this.opts.includeSsot && shouldSkip(c.name)) continue;
        const logicalId = this.normalize("Connection", c.name);
        const effectiveType = c.connectorType ?? connectorType;
        const entry: ConnectionEntry = {
          kind: "Connection",
          logicalId,
          apiName: c.name,
          salesforceId: c.id,
          connectorType: effectiveType,
          label: c.label ?? c.name,
        };
        if (effectiveType === "IngestApi") {
          const schema = await this.fetchSchema(c.id, c.name);
          if (schema) (entry as { schema?: ConnectionSchemaSketch }).schema = schema;
        }
        entries.push(entry);
      }
    }
    return { entries };
  }

  private normalize(kind: string, apiName: string): string {
    if (this.opts.preserveNames) return apiName;
    const normalized = normalizeLogicalId(apiName);
    if (normalized !== apiName) {
      this.normalizations.push({ kind, from: apiName, to: normalized });
    }
    return normalized;
  }

  private async fetchSchema(
    connectionId: string,
    connectionName: string,
  ): Promise<ConnectionSchemaSketch | undefined> {
    try {
      const raw = (await this.client.connections.listSchema(connectionId)) as {
        connectionSchema?: Array<{
          name?: string;
          label?: string;
          fieldInfo?: Array<{ name?: string; dataType?: string; isPrimaryKey?: boolean; type?: string }>;
        }>;
      };
      const first = raw.connectionSchema?.[0];
      if (!first?.name) return undefined;
      const fields = (first.fieldInfo ?? [])
        .filter((f): f is { name: string; dataType?: string; isPrimaryKey?: boolean; type?: string } =>
          typeof f.name === "string" && f.name.length > 0,
        )
        .map((f) => {
          const field: { name: string; dataType: string; isPrimaryKey?: boolean } = {
            name: f.name,
            dataType: f.dataType ?? f.type ?? "Text",
          };
          if (f.isPrimaryKey) field.isPrimaryKey = true;
          return field;
        });
      return {
        schemaName: first.name,
        label: first.label ?? first.name,
        fields,
      };
    } catch {
      // Schema endpoint may 404 for connections that haven't registered one;
      // that's fine — emit the connection without it.
      void connectionName;
      return undefined;
    }
  }
}

// ── Manifest rendering ──────────────────────────────────────────────────────

function renderManifest(
  snapshot: Snapshot,
  opts: { stack: string; org: string; normalizations: ReadonlyArray<NormalizationNote> },
): string {
  const bodyLines: string[] = [];
  for (const e of snapshot.entries) {
    bodyLines.push(renderConnection(e));
    bodyLines.push("");
  }

  return [
    renderHeader(opts),
    `import { App, Stack, Connection } from "afd360";`,
    ``,
    `const app = new App();`,
    `const stack = new Stack(app, ${JSON.stringify(opts.stack)}, { targetOrg: ${JSON.stringify(opts.org)} });`,
    ``,
    ...bodyLines,
    `export default app;`,
    ``,
  ].join("\n");
}

function renderHeader(opts: {
  org: string;
  normalizations: ReadonlyArray<NormalizationNote>;
}): string {
  const lines = [
    `/**`,
    ` * Generated by \`afd360 import\` on ${new Date().toISOString().slice(0, 10)}.`,
    ` * Source org: ${opts.org}.`,
    ` *`,
    ` * v1 import covers Connection resources only — fill in credentials in a`,
    ` * .env file (afd360 reads \${env.X} tokens at deploy time). DataStream,`,
    ` * DMO, Mapping, Relationship, CalculatedInsight, and SearchIndex are not`,
    ` * yet round-trippable; add those by hand or wait for a later release.`,
  ];
  if (opts.normalizations.length > 0) {
    lines.push(` *`);
    lines.push(` * Normalized logical ids (api name → logical id):`);
    for (const n of opts.normalizations) {
      lines.push(` *   ${n.kind}: ${n.from} → ${n.to}`);
    }
    lines.push(` *`);
    lines.push(` * The api name is preserved on the construct's \`name\` prop and in the`);
    lines.push(` * seeded state file, so redeploy is a noop. Re-run with`);
    lines.push(` * --preserve-names to skip normalization.`);
  }
  lines.push(` */`);
  return lines.join("\n");
}

function renderConnection(e: ConnectionEntry): string {
  const propLines: string[] = [
    `  connectorType: ${JSON.stringify(e.connectorType)},`,
    `  label: ${JSON.stringify(e.label)},`,
    `  name: ${JSON.stringify(e.apiName)},`,
  ];
  // Credential / parameter shape varies by connector family. We emit empty
  // placeholders plus a TODO hint so the user sees exactly where to wire up
  // their .env. afd360 never reads or emits live secret values.
  if (e.connectorType !== "IngestApi" && e.connectorType !== "SalesforceDotCom") {
    propLines.push(`  credentials: {`);
    propLines.push(`    // TODO: add credential keys for ${e.connectorType}. See`);
    propLines.push(`    // the ${e.connectorType} connector docs for required fields.`);
    propLines.push(`    // Reference values from .env via \${env.X} substitution.`);
    propLines.push(`  },`);
    propLines.push(`  parameters: {`);
    propLines.push(`    // TODO: add ${e.connectorType}-specific parameters (e.g. bucket, host).`);
    propLines.push(`  },`);
  }
  if (e.schema) {
    propLines.push(`  schema: {`);
    propLines.push(`    name: ${JSON.stringify(e.schema.schemaName)},`);
    propLines.push(`    label: ${JSON.stringify(e.schema.label)},`);
    propLines.push(`    fields: [`);
    for (const f of e.schema.fields) {
      const parts = [`name: ${JSON.stringify(f.name)}`, `dataType: ${JSON.stringify(f.dataType)}`];
      if (f.isPrimaryKey) parts.push(`isPrimaryKey: true`);
      propLines.push(`      { ${parts.join(", ")} },`);
    }
    propLines.push(`    ],`);
    propLines.push(`  },`);
  }
  return [
    `new Connection(stack, ${JSON.stringify(e.logicalId)}, {`,
    ...propLines,
    `});`,
  ].join("\n");
}

// ── State seed ──────────────────────────────────────────────────────────────

function buildStateFile(
  snapshot: Snapshot,
  stackName: string,
  targetOrg: string,
): StackState {
  const now = new Date().toISOString();
  const resources: Record<string, StateResource> = {};
  for (const e of snapshot.entries) {
    const uniqueId = `${stackName}/${e.logicalId}`;
    // Hash the same props shape that the emitted manifest's Connection
    // construct will resolve to. This makes `afd360 diff` immediately after
    // import report noop (assuming the user hasn't filled in credentials
    // yet — empty bucket matches what the construct normalizes to too).
    // Once the user edits the manifest to add real credentials/parameters,
    // the next diff will correctly show `recreate`.
    const authoredProps = buildAuthoredConnectionProps(e);
    const entry: StateResource = {
      type: "Connection",
      apiName: e.apiName,
      salesforceId: e.salesforceId,
      hash: hashProps(authoredProps),
      createdAt: now,
    };
    resources[uniqueId] = entry;
    if (e.schema) {
      // ConnectionSchema uses composite id <connectionId>::<schemaName>.
      const schemaUid = `${uniqueId}/${e.logicalId}Schema`;
      resources[schemaUid] = {
        type: "ConnectionSchema",
        apiName: e.schema.schemaName,
        salesforceId: `${e.salesforceId}::${e.schema.schemaName}`,
        hash: hashProps(buildAuthoredSchemaProps(e.schema, e.apiName)),
        createdAt: now,
      };
    }
  }
  return {
    stackName,
    targetOrg,
    lastDeployedAt: now,
    resources,
  };
}

/**
 * Reproduce the ConnectionResource's authored-props shape from the imported
 * entry. Must match the shape the Connection construct resolves to at synth
 * time, so seeded-hash equals computed-hash on first diff.
 *
 * Keep this in sync with `Connection.props` normalization (src/resources/
 * connection.ts:~260). If you add a normalized default there, mirror it here.
 */
function buildAuthoredConnectionProps(e: ConnectionEntry): Record<string, unknown> {
  const props: Record<string, unknown> = {
    connectorType: e.connectorType,
    label: e.label,
    name: e.apiName,
  };
  // Empty credential / parameter buckets — matches the rendered manifest's
  // `credentials: {}` and `parameters: {}` stubs. Once the user fills them
  // in, the next diff reports recreate — which is correct behavior.
  if (e.connectorType !== "IngestApi" && e.connectorType !== "SalesforceDotCom") {
    props["credentials"] = {};
    props["parameters"] = {};
  }
  return props;
}

function buildAuthoredSchemaProps(
  schema: ConnectionSchemaSketch,
  connectionName: string,
): Record<string, unknown> {
  return {
    connectionName,
    schemaName: schema.schemaName,
    label: schema.label,
    fields: schema.fields,
  };
}
