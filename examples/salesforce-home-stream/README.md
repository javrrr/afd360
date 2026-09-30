# Same-org CRM (Home) DataStream

Bring **this org's own Salesforce objects** — standard (`Account`, `Lead`, …)
or custom (`P_Region__c`, …) — into Data Cloud, with no external credentials.

## Why there are no credentials

Data Cloud ships a built-in connector for the org it lives in, exposed as the
connection **`Salesforce_Home`** (internal dev name `SalesforceDotCom_Home`).
It's provisioned and authenticated by the platform. afd360 *references* it via:

```ts
const home = Connection.salesforceHome(stack);
```

This adopts the existing connection on `deploy` and **never deletes it** on
`destroy` (it isn't yours to delete). If your org reports different internal
names, use the generic escape hatch:

```ts
Connection.fromExisting(stack, "Home", {
  name: "SalesforceDotCom_Home",
  connectorType: "SalesforceDotCom",
  dataSourceName: "Salesforce_Home",
});
```

## What you declare vs. what the platform derives

You declare only the **source object** and its **primary key**. The platform
auto-introspects the sObject and materializes every column into the DLO — you
do not list fields (unlike AwsS3/Snowflake streams).

- **DLO name**: `<Object>_Home__dll`, with a trailing `__c` stripped from
  custom objects — `Account` → `Account_Home__dll`, `P_Region__c` →
  `P_Region_Home__dll`.
- **DLO field names** flatten `__c` → `_c` (e.g. `ExternalId__c` becomes
  `ExternalId_c`). Reference the flattened names if you add a `Mapping` to a
  custom DMO.
- **`recordModifiedFieldName`** defaults to `SystemModstamp`; override per
  stream only if an object uses a different audit field.
- **Category**: `Profile` for identity objects (Account, Contact, Lead),
  `Other` for everything else (default). `Engagement` also requires
  `eventDateTimeFieldName`.

## Run it

```sh
npx afd360 synth -c afd360.config.ts          # construct-time validation, no org I/O
npx afd360 diff --org <alias>                 # preview create/adopt
npx afd360 deploy --org <alias>               # apply
```

No `.env` is needed — there are no secrets to fill in.
