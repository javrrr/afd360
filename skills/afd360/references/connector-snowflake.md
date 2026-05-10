# Snowflake connector recipe (federated / BYOL)

## Connection

```ts
new Connection(stack, "MySnowflake", {
  connectorType: "SNOWFLAKE",        // UPPERCASE — connector-family casing matters
  label: "Snowflake",
  method: "Ingress",
  credentials: {
    authenticationOption: "KeyPair",
    user: "${env.SNOWFLAKE_USER}",
    privateKey: "${pem:${env.SNOWFLAKE_PRIVATE_KEY_PATH}}",
  },
  parameters: {
    accountUrl: "${env.SNOWFLAKE_ACCOUNT_URL}",
    warehouse: "${env.SNOWFLAKE_WAREHOUSE}",
    region: "${env.SNOWFLAKE_REGION}",    // required for streams
    unloadData: "true",                   // required for streams
    hasPrivateNetworkRoute: "false",
  },
});
```

### Non-obvious requirements

- `region` and `unloadData: "true"` are marked `required=false` in
  connector metadata but the DataStream wizard errors without them.
- `privateKey` needs the base64 body only — `${pem:PATH}` strips PEM
  headers and whitespace automatically.
- The Snowflake user must have keypair auth configured server-side
  (`ALTER USER X SET RSA_PUBLIC_KEY = '...'`).

## DataStream

Snowflake streams are **federated** (zero-copy). Data stays in Snowflake,
queried on demand. Requires `snowflake: { database, schema, object, fields }`.

Snowflake **uppercases** unquoted identifiers — column names should be
UPPERCASE unless the user has quoted them at table creation.

Default `refreshMode` is `TOTAL_REPLACE`. Use `INCREMENTAL` with
`incrementalColumn` only when the table has a monotonically-increasing
column (timestamp or version number).

```ts
new DataStream(stack, "ProductsStream", {
  connection: conn,
  sourceObject: "Products",
  label: "Products (Snowflake)",
  category: "Other",
  refreshMode: "TOTAL_REPLACE",
  primaryKey: { name: "ID", dataType: "Text" },
  snowflake: {
    database: "NTO",
    schema: "PUBLIC",
    object: "SSOT_GOODSPRODUCT",
    fields: [
      { name: "ID",              dataType: "Text", isPrimaryKey: true },
      { name: "NAME",            dataType: "Text" },
      { name: "DESCRIPTION",     dataType: "Text" },
      { name: "LONGDESCRIPTION", dataType: "Text" },
    ],
  },
});
```

## Env keys

```
SNOWFLAKE_ACCOUNT_URL=          # e.g. xy12345.eu-central-1.snowflakecomputing.com
SNOWFLAKE_USER=
SNOWFLAKE_WAREHOUSE=
SNOWFLAKE_REGION=               # e.g. eu-central-1
SNOWFLAKE_PRIVATE_KEY_PATH=     # absolute or ~/path to PKCS#8 (.p8) file
```
