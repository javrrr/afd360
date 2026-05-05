/**
 * S3 Connection integration — proves the secret-substitution path end to end.
 *
 * One AwsS3 Connection; no DataStream in this milestone (M5 picks that up
 * once DataStream is generalized beyond IngestApi).
 *
 * To run:
 *   1. Copy .env.example → .env.local (gitignored).
 *   2. Fill AWS_ACCESS_KEY / AWS_ACCESS_SECRET.
 *   3. From this directory:
 *        node ../../../dist/cli/index.js synth   -c ./afd360.config.ts
 *        node ../../../dist/cli/index.js diff    -c ./afd360.config.ts
 *        node ../../../dist/cli/index.js deploy  -c ./afd360.config.ts
 *        node ../../../dist/cli/index.js destroy -c ./afd360.config.ts
 */
import { App, Stack, Connection } from "../../../src/index.js";

const app = new App();
const stack = new Stack(app, "AFD360S3", { targetOrg: "jaygentforce" });

new Connection(stack, "AFD360S3Conn", {
  connectorType: "AwsS3",
  label: "afd360 s3 test",
  method: "Ingress",
  credentials: {
    authenticationOption: "accessKeyAndSecret",
    accessKey: "${env.AWS_ACCESS_KEY}",
    accessSecret: "${env.AWS_ACCESS_SECRET}",
  },
  parameters: {
    bucketName: "cdp-data-javier",
    parentDirectory: "/",
  },
});

export default app;
