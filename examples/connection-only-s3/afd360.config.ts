/**
 * AwsS3 Connection only — no streams, no DMOs.
 *
 * Replace TARGET_ORG and BUCKET_NAME with the user's values. Fill in
 * AWS_ACCESS_KEY / AWS_ACCESS_SECRET in .env before deploying.
 */
import { App, Stack, Connection } from "afd360";

const TARGET_ORG = "my-org";
const BUCKET_NAME = "my-bucket";

const app = new App();
const stack = new Stack(app, "S3Setup", { targetOrg: TARGET_ORG });

new Connection(stack, "DocsS3", {
  connectorType: "AwsS3",
  label: "Docs S3",
  method: "Ingress",
  credentials: {
    authenticationOption: "accessKeyAndSecret",
    accessKey: "${env.AWS_ACCESS_KEY}",
    accessSecret: "${env.AWS_ACCESS_SECRET}",
  },
  parameters: {
    bucketName: BUCKET_NAME,
    parentDirectory: "/",
  },
});

export default app;
