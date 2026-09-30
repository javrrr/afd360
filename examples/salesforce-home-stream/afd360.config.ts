/**
 * Same-org CRM (Home) DataStream — bring this org's own Salesforce objects
 * (standard or custom) into Data Cloud.
 *
 * No external credentials: the built-in "Salesforce_Home" connector is
 * provisioned by the platform and authenticated by the org itself.
 * `Connection.salesforceHome(stack)` REFERENCES it (adopts on deploy, never
 * deletes on destroy) — it does not create a connection.
 *
 * The platform auto-introspects each sObject from the primary key alone, so
 * you don't declare fields — just the source object and its PK. Replace
 * TARGET_ORG and the objects with your own.
 */
import { App, Stack, Connection, DataStream } from "afd360";

const TARGET_ORG = "my-org";

const app = new App();
const stack = new Stack(app, "HomeCrm", { targetOrg: TARGET_ORG });

// The built-in same-org CRM connector. One reference, reused by every stream.
const home = Connection.salesforceHome(stack);

// Standard object → Profile. DLO becomes "Account_Home__dll".
new DataStream(stack, "AccountHome", {
  connection: home,
  sourceObject: "Account",
  category: "Profile",
  primaryKey: { name: "Id" },
});

// Custom object → Other. The trailing __c is stripped from the DLO name:
// "P_Region__c" → DLO "P_Region_Home__dll". Custom DLO *field* names flatten
// too (e.g. "ExternalId__c" → "ExternalId_c"), which matters when you add a
// Mapping to a DMO later.
new DataStream(stack, "RegionHome", {
  connection: home,
  sourceObject: "P_Region__c",
  category: "Other",
  primaryKey: { name: "Id" },
  // recordModifiedFieldName defaults to "SystemModstamp" (present on every
  // sObject); override only if an object uses a different audit field.
});

export default app;
