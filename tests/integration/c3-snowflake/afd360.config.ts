/**
 * Snowflake Connection integration — proves the ${file:...} + dotenv path
 * for a multi-line-secret connector.
 *
 * No DataStream in this round; M5 picks that up when DataStream is
 * generalized beyond IngestApi + AwsS3.
 *
 * Run:
 *   cp .env.example .env.local
 *   # fill SNOWFLAKE_ACCOUNT_URL, SNOWFLAKE_USER, SNOWFLAKE_WAREHOUSE,
 *   # SNOWFLAKE_PRIVATE_KEY_PATH
 *   node ../../../dist/cli/index.js deploy -c ./afd360.config.ts
 *
 * Snowflake connector type is "SNOWFLAKE" (UPPERCASE — unlike "AwsS3").
 */
import { App, Stack, Connection } from "../../../src/index.js";

const app = new App();
const stack = new Stack(app, "AFD360SF", { targetOrg: "jaygentforce" });

new Connection(stack, "AFD360SFConn", {
  connectorType: "SNOWFLAKE",
  label: "afd360 snowflake test",
  method: "Ingress",
  credentials: {
    authenticationOption: "KeyPair",
    hasPrivateNetworkRoute: "false",
    user: "${env.SNOWFLAKE_USER}",
    accountUrl: "${env.SNOWFLAKE_ACCOUNT_URL}",
    warehouse: "${env.SNOWFLAKE_WAREHOUSE}",
    // PKCS#8 private key — multi-line PEM. ${file:...} reads the file at
    // deploy time; contents never live in .env.local.
    privateKey: "${file:${env.SNOWFLAKE_PRIVATE_KEY_PATH}}",
    // If the key is passphrase-protected, uncomment:
    // passphrase: "${env.SNOWFLAKE_PASSPHRASE}",
  },
  // The Snowflake connector stores database/schema/object on the DataStream
  // (advancedAttributes), not at the connection level — see
  // GET /ssot/connectors/SNOWFLAKE. So no `parameters` here.
});

export default app;
