/**
 * C6.1 — CalculatedInsight over a pre-existing DMO.
 *
 * Uses `NTOProduct__dlm` — a custom DMO that already exists in jaygentforce
 * (created by the tdc project, with an active mapping). The CI computes a
 * simple COUNT — enough to prove the plumbing; real demos would use larger
 * expressions.
 *
 * `publishScheduleInterval: "NotScheduled"` to avoid the publishSchedule-
 * StartDateTime idempotency trap (the default future-dated timestamp drifts
 * every synth and would force recreate on every redeploy).
 */
import { App, Stack, CalculatedInsight } from "../../../src/index.js";

const app = new App();
const stack = new Stack(app, "AFD360C61", { targetOrg: "jaygentforce" });

new CalculatedInsight(stack, "Afd360C61ProductCount", {
  displayName: "afd360 C6.1 Product Count",
  description: "Total NTOProduct DMO rows — afd360 C6.1 checkpoint probe.",
  definitionType: "CALCULATED_METRIC",
  publishScheduleInterval: "NotScheduled",
  expression: `
    SELECT
      COUNT(NTOProduct__dlm.Id__c) AS product_count__c
    FROM NTOProduct__dlm
  `.trim(),
});

export default app;
