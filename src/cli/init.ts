/**
 * `afd360 init <dir>` — scaffold a new afd360 project from templates/starter.
 *
 * Copies the template tree verbatim into <dir>. Refuses to overwrite an
 * existing afd360.config.ts — users with an existing manifest want
 * `afd360 import`, not init.
 *
 * The template ships a full RAG pipeline (S3 → Stream → DMO → Mapping →
 * SearchIndex) with TODOs the user fills in before `deploy`. Deliberately
 * opinionated: AwsS3 because it's the simplest reproducible source, CSV
 * because it doesn't require extra parsing config, and HYBRID / NEAR_REALTIME
 * on the SearchIndex because those are the aporg KA_Knowledge defaults.
 */
import { Command } from "commander";
import { mkdir, readdir, copyFile, stat, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pc from "picocolors";

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("Scaffold a new afd360 project in <dir>")
    .argument("<dir>", "target directory (created if missing)")
    .action(async (dir: string) => {
      const target = resolve(process.cwd(), dir);
      const existing = join(target, "afd360.config.ts");
      if (await pathExists(existing)) {
        throw new Error(
          `${dir} already contains an afd360.config.ts — refusing to overwrite. ` +
            `For an existing org use \`afd360 import\` instead.`,
        );
      }

      const templateRoot = resolveTemplateRoot();
      await copyTree(templateRoot, target);

      process.stdout.write(
        [
          `${pc.green("init")}   ${dir} scaffolded from templates/starter`,
          ``,
          `next steps:`,
          `  cd ${dir}`,
          `  cp .env.example .env   # fill in S3 credentials`,
          `  npm install            # installs afd360 + peers`,
          `  # edit afd360.config.ts — set TARGET_ORG, SOURCE_BUCKET, SOURCE_FILE`,
          `  npx afd360 whoami --org <alias>`,
          `  npx afd360 diff --org <alias>`,
          `  npx afd360 deploy --org <alias>`,
          ``,
        ].join("\n"),
      );
    });
}

/**
 * Resolve the on-disk path to `templates/starter`. Works whether we're
 * running from the published package (dist/cli/index.js alongside
 * ../../templates) or from a repo-local dev build (dist/cli/index.js with
 * ../../templates).
 */
function resolveTemplateRoot(): string {
  // Traverse up from this source file to find the package root. Both the
  // built CLI and the ts source live 2 levels below the package root
  // (src/cli/init.ts → repo root; dist/cli/index.js → repo root).
  const here = fileURLToPath(import.meta.url);
  const cliDir = dirname(here);          // .../dist/cli  OR  .../src/cli
  const pkgDir = dirname(dirname(cliDir)); // .../pkg-root
  return join(pkgDir, "templates", "starter");
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function copyTree(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src);
  for (const name of entries) {
    const from = join(src, name);
    const to = join(dest, name);
    const info = await stat(from);
    if (info.isDirectory()) {
      await copyTree(from, to);
    } else {
      await copyFile(from, to);
    }
  }
}
