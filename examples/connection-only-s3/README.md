# Example: AwsS3 Connection only

**Use when** the user wants to set up an S3 connection in Data Cloud and
nothing else — no streams, no DMOs, no search indexes. Common as a
first integration step before deciding what data to ingest.

## What this deploys

A single `Connection` of type `AwsS3`, with credentials sourced from a
`.env` file at deploy time.

## What the user provides

- `targetOrg` — their `sf` CLI org alias.
- `bucketName` — the S3 bucket to connect to.
- AWS credentials in `.env`.

## What's defaulted

- `parentDirectory: "/"` — connect to the bucket root. Adjust if the
  user wants to scope to a sub-prefix.
- `method: "Ingress"` — read-into-Data-Cloud. Set to `"Egress"` only
  for activation targets.
- `authenticationOption: "accessKeyAndSecret"`. Snowflake-style key
  pair isn't supported for AwsS3.

## Adapt this

Change `BUCKET_NAME` to the user's bucket. Set `targetOrg` to their
alias. Rename the `Connection` logical id (`"DocsS3"`) and `label`
(`"Docs S3"`) to something domain-meaningful — these are the
identifiers that appear in the Data Cloud UI.
