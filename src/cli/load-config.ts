import { pathToFileURL } from "node:url";
import { resolve, isAbsolute } from "node:path";
import { App } from "../core/app.js";

/**
 * Load the user's afd360.config.ts and return its default-exported App.
 * Uses tsx's programmatic ESM loader so the user doesn't need to pre-compile.
 *
 * Convention (documented in templates/starter and README):
 *   // afd360.config.ts
 *   const app = new App();
 *   // ... stacks + resources
 *   export default app;
 */
export async function loadApp(configPath: string): Promise<App> {
  const abs = isAbsolute(configPath) ? configPath : resolve(process.cwd(), configPath);
  const { tsImport } = (await import("tsx/esm/api")) as typeof import("tsx/esm/api");
  const mod = (await tsImport(pathToFileURL(abs).href, import.meta.url)) as {
    default?: unknown;
  };
  const app = mod.default;
  // Duck-type check — when the user imports from ./src, they get a different
  // class identity than the CLI's `instanceof App`. Check for the structural
  // contract instead: `synth()` + `stacks[]`.
  if (!isApp(app)) {
    throw new Error(
      `${configPath} must default-export an App instance. ` +
        `Add \`export default app\` at the bottom of the file.`,
    );
  }
  return app as App;
}

function isApp(v: unknown): v is App {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { synth?: unknown }).synth === "function" &&
    Array.isArray((v as { stacks?: unknown }).stacks)
  );
}
