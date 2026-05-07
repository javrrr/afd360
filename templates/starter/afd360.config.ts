/**
 * afd360 manifest. Add resources to the stack, then deploy:
 *
 *   npx afd360 whoami --org <alias>
 *   npx afd360 diff   --org <alias>
 *   npx afd360 deploy --org <alias>
 *
 * Set TARGET_ORG to your sf CLI org alias (run `sf org list` to see yours).
 *
 * Reference: docs/resources.md (in node_modules/afd360/), examples/ for
 * scenario manifests you can adapt, AGENTS.md for AI-assistant guidance.
 */
import { App, Stack } from "afd360";

const TARGET_ORG = "my-org";

const app = new App();
const stack = new Stack(app, "MyStack", { targetOrg: TARGET_ORG });

// Add resources here. Examples:
//   import { Connection } from "afd360";
//   new Connection(stack, "MyS3", { connectorType: "AwsS3", ... });

void stack;

export default app;
