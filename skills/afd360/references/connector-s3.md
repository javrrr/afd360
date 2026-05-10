# AwsS3 connector recipe

## Connection

```ts
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
    bucketName: "my-bucket",    // literal, not a secret
    parentDirectory: "/",
  },
});
```

## DataStream

Requires `s3: { fileType, fileName, fields }`. CSV column names are
**literal** — preserve casing and spaces. Exactly one field with
`isPrimaryKey: true`.

```ts
new DataStream(stack, "ArticlesStream", {
  connection: conn,
  sourceObject: "articles",
  label: "Articles",
  category: "Other",
  refreshMode: "UPSERT",
  primaryKey: { name: "Id", dataType: "Text" },
  s3: {
    fileType: "CSV",
    importDirectory: "knowledge",
    fileName: "articles.csv",
    areHeadersIncludedInFile: "true",
    fields: [
      { name: "Id",    dataType: "Text", isPrimaryKey: true },
      { name: "Title", dataType: "Text" },
      { name: "Body",  dataType: "Text" },
    ],
  },
});
```

## Env keys

```
AWS_ACCESS_KEY=
AWS_ACCESS_SECRET=
```

Bucket name goes as a literal in the manifest (it's an identifier, not
a secret).
