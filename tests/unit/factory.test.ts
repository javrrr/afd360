import { describe, it, expect } from "vitest";
import {
  buildBaseUrl,
  createClient,
  createSemanticsClient,
  SEMANTICS_API_VERSION,
} from "../../src/client/factory.js";
import type { Session } from "../../src/client/auth.js";

const session: Session = {
  alias: "test",
  username: "u@example.com",
  orgId: "00D...",
  instanceUrl: "https://x.my.salesforce.com",
  apiVersion: "66.0",
  accessToken: "tok",
};

describe("buildBaseUrl", () => {
  it("appends /services/data/v<apiVersion> to instanceUrl", () => {
    expect(buildBaseUrl("https://x.my.salesforce.com", "66.0"))
      .toBe("https://x.my.salesforce.com/services/data/v66.0");
  });
  it("trims trailing slashes", () => {
    expect(buildBaseUrl("https://x.my.salesforce.com/", "66.0"))
      .toBe("https://x.my.salesforce.com/services/data/v66.0");
    expect(buildBaseUrl("https://x.my.salesforce.com///", "66.0"))
      .toBe("https://x.my.salesforce.com/services/data/v66.0");
  });
});

describe("createClient", () => {
  it("constructs a Data360Client from a Session", () => {
    const client = createClient(session);
    // Data360Client exposes typed service fields — presence check is enough.
    expect(client.metadata).toBeDefined();
    expect(client.connections).toBeDefined();
    expect(client.dataModelObjects).toBeDefined();
  });
});

describe("createSemanticsClient", () => {
  it("pins the semantic-model surface to v65", () => {
    // The SDK bakes no version — it lives in the base URL we build. SemanticModel
    // moved off the hand-rolled v64 seam onto this generated v65 client.
    expect(SEMANTICS_API_VERSION).toBe("65.0");
  });

  it("constructs a TableauSemanticsClient (symlinked SDK resolves at runtime)", () => {
    const client = createSemanticsClient(session);
    // The composed service fields the SemanticModel construct uses.
    expect(client.semanticModels).toBeDefined();
    expect(client.semanticQuery).toBeDefined();
  });
});
