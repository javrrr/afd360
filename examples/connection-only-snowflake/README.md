# Example: Snowflake Connection only

**Use when** the user wants to set up a Snowflake federated connection
and nothing else. Common as a first step before deciding which tables
to expose as DataStreams.

## What this deploys

A single `Connection` of type `SNOWFLAKE`, keypair auth, federated
(BYOL / zero-copy) read access.

## What the user provides

- `targetOrg` — their `sf` CLI org alias.
- Snowflake account URL (e.g. `xy12345.eu-west-1.snowflakecomputing.com`).
- Snowflake user (must have keypair auth configured server-side).
- Warehouse and region.
- Path to the PKCS#8 private key file (`.p8`).

## What's defaulted

- `authenticationOption: "KeyPair"` — username/password isn't
  supported.
- `unloadData: "true"` — required for DataStreams to discover tables
  via the wizard. Connector metadata marks this optional but it's
  effectively required.
- `region` — also marked optional in connector metadata but required
  for DataStream creation. User must supply.
- `hasPrivateNetworkRoute: "false"` — flip to `"true"` only if the
  user is using PrivateLink.

## Adapt this

Change `TARGET_ORG`. Verify the user's Snowflake user has
RSA_PUBLIC_KEY configured server-side (`ALTER USER X SET
RSA_PUBLIC_KEY = '...'`) before deploying. Confirm region matches the
Snowflake account's actual region (e.g. `eu-central-1`,
`us-east-1`); afd360 doesn't validate this and the failure mode is a
silent stuck connection test.
