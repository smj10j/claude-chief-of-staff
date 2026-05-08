import { describe, it, expect } from "vitest";

import { findMcp, mcpStatus, type McpServer } from "./Ops";

const SAMPLE: McpServer[] = [
  { name: "datadog-mcp", info: "ok", connected: true },
  { name: "plugin_rollbar_rollbar", info: "untested", connected: false },
  { name: "slack-local-mcp", info: "ok", connected: true },
];

describe("findMcp", () => {
  it("returns a connected match by substring", () => {
    expect(findMcp(SAMPLE, "datadog")?.name).toBe("datadog-mcp");
  });
  it("matches case-insensitively", () => {
    expect(findMcp(SAMPLE, "ROLLBAR")?.name).toBe("plugin_rollbar_rollbar");
  });
  it("returns null when not found", () => {
    expect(findMcp(SAMPLE, "bigquery")).toBeNull();
  });
  it("returns null when servers is null", () => {
    expect(findMcp(null, "anything")).toBeNull();
  });
});

describe("mcpStatus", () => {
  it("reports ok when connected", () => {
    expect(mcpStatus(SAMPLE[0])).toBe("ok");
  });
  it("reports broken when registered but not connected", () => {
    expect(mcpStatus(SAMPLE[1])).toBe("broken");
  });
  it("reports missing when null", () => {
    expect(mcpStatus(null)).toBe("missing");
  });
});
