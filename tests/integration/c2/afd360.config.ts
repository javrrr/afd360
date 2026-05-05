/**
 * C2 checkpoint — single Connection round trip against jaygentforce.
 *
 * Authoring note: this lives under tests/integration/c2/. Run from that dir:
 *   afd360 synth  -c ./afd360.config.ts -o ./.afd360/plan.json
 *   afd360 diff   -c ./afd360.config.ts
 *   afd360 deploy -c ./afd360.config.ts
 *   afd360 deploy -c ./afd360.config.ts   (should be noop)
 *   afd360 destroy -c ./afd360.config.ts
 */
import { App, Stack, Connection } from "../../../src/index.js";

const app = new App();
const stack = new Stack(app, "AFD360C2", { targetOrg: "jaygentforce" });

new Connection(stack, "C2Ingest", {
  connectorType: "IngestApi",
  label: "afd360_c2_ingest",
});

export default app;
