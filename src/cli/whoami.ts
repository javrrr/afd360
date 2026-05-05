import pc from "picocolors";
import { Command } from "commander";
import { getSession } from "../client/auth.js";
import { createClient } from "../client/factory.js";

export function registerWhoami(program: Command): void {
  program
    .command("whoami")
    .description("Verify auth + Data 360 reachability for an org alias")
    .requiredOption("-o, --org <alias>", "sf CLI org alias")
    .action(async (opts: { org: string }) => {
      const session = await getSession(opts.org);
      const client = createClient(session);

      // Liveness probe — cheap, typed call that proves the token + Data 360 entitlement.
      // connectorType filter is required by the API; IngestApi is always valid.
      await client.connections.list({ connectorType: "IngestApi", batchSize: 1 });

      // One line per field — keeps the output easy to grep in scripts.
      process.stdout.write(
        [
          `${pc.bold("alias")}       ${session.alias}`,
          `${pc.bold("username")}    ${session.username}`,
          `${pc.bold("orgId")}       ${session.orgId}`,
          `${pc.bold("instanceUrl")} ${session.instanceUrl}`,
          `${pc.bold("apiVersion")}  ${session.apiVersion}`,
          "",
        ].join("\n"),
      );
    });
}
