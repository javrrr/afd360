/**
 * C6 — SearchIndex RAG checkpoint (advanced config).
 *
 * Points at `NTOProduct__dlm`, a custom DMO already materialized on
 * jaygentforce via the tdc project. Exercises the aporg-style advanced
 * configuration on SearchIndex:
 *
 *   - Multi-field chunking (LongDescription + Description) — each field gets
 *     its own passage_extraction config.
 *   - `prepend` decorators — inject the product Name onto every chunk as
 *     context, mirroring how aporg's KA_Knowledge prepends Description /
 *     Question onto the chunked article body.
 *   - Multi-field `vectorEmbeddingRelatedFields` — PK + two filterable
 *     fields indexed alongside the embedding for downstream retrieval.
 *
 * NTOProduct__dlm was chosen because:
 *   1. It's already ingested and mapped (afd360 creates the SearchIndex only,
 *      not the stream/DLO/DMO/mapping upstream).
 *   2. It has the long-text fields chunking needs (LongDescription, Description).
 *   3. The tdc reference sets precedent (scripts/data-cloud/nto-search-index.ts).
 *
 * If / when the AfdKnowProbe stream gets mapped to a DMO, swap the
 * `sourceDmo` value here to that DMO's dev name — the rest of the config is
 * mechanical.
 */
import { App, Stack, SearchIndex } from "../../../src/index.js";

const app = new App();
const stack = new Stack(app, "AFD360C6", { targetOrg: "jaygentforce" });

new SearchIndex(stack, "Afd360C6ProductIdx", {
  label: "afd360 C6 Product Search",
  description: "C6 checkpoint — multi-field chunking with decorators over NTOProduct.",
  sourceDmo: "NTOProduct__dlm",
  searchType: "HYBRID",
  processingType: "NEAR_REALTIME",
  fields: [
    {
      fieldDeveloperName: "LongDescription__c",
      decorators: [
        {
          decoratorId: "prepend",
          dmoDeveloperName: "NTOProduct__dlm",
          dmoFieldDeveloperName: "Name__c",
        },
      ],
    },
    {
      fieldDeveloperName: "Description__c",
      decorators: [
        {
          decoratorId: "prepend",
          dmoDeveloperName: "NTOProduct__dlm",
          dmoFieldDeveloperName: "Name__c",
        },
      ],
    },
  ],
  vectorRelatedFields: [
    // PK — required per quirk C3.
    { dmoDeveloperName: "NTOProduct__dlm", fieldDeveloperName: "Id__c" },
    // Extra filterable context on the embedding row.
    { dmoDeveloperName: "NTOProduct__dlm", fieldDeveloperName: "Category1__c" },
    { dmoDeveloperName: "NTOProduct__dlm", fieldDeveloperName: "ProductSKU__c" },
  ],
});

export default app;
