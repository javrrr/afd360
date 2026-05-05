import { describe, it, expect } from "vitest";
import { buildBaseUrl, createClient } from "../../src/client/factory.js";
import type { Session } from "../../src/client/auth.js";

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
    const session: Session = {
      alias: "test",
      username: "u@example.com",
      orgId: "00D...",
      instanceUrl: "https://x.my.salesforce.com",
      apiVersion: "66.0",
      accessToken: "tok",
    };
    const client = createClient(session);
    // Data360Client exposes typed service fields — presence check is enough.
    expect(client.metadata).toBeDefined();
    expect(client.connections).toBeDefined();
    expect(client.dataModelObjects).toBeDefined();
  });
});
