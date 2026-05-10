/**
 * Snowflake Connection only — no streams.
 *
 * Replace TARGET_ORG and fill in .env values. The Snowflake user must
 * have keypair auth set up server-side before this will deploy
 * (ALTER USER ... SET RSA_PUBLIC_KEY = '...').
 */
import { App, Stack, Connection } from "afd360";

const TARGET_ORG = "my-org";

const app = new App();
const stack = new Stack(app, "SnowflakeSetup", { targetOrg: TARGET_ORG });

new Connection(stack, "MySnowflake", {
  connectorType: "SNOWFLAKE", // UPPERCASE — connector-family casing matters.
  label: "Snowflake",
  method: "Ingress",
  credentials: {
    authenticationOption: "KeyPair",
    user: "${env.SNOWFLAKE_USER}",
    privateKey: "${pem:${env.SNOWFLAKE_PRIVATE_KEY_PATH}}",
    // Uncomment if the private key is passphrase-protected:
    // passphrase: "${env.SNOWFLAKE_PASSPHRASE}",
  },
  parameters: {
    accountUrl: "${env.SNOWFLAKE_ACCOUNT_URL}",
    warehouse: "${env.SNOWFLAKE_WAREHOUSE}",
    region: "${env.SNOWFLAKE_REGION}",
    unloadData: "true",
    hasPrivateNetworkRoute: "false",
  },
});

export default app;
