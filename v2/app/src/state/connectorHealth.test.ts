import { describe, expect, it } from "vitest";

import {
  deriveConnectorHealth,
  isCapabilityServer,
  matchesCapability,
  type McpServer,
} from "./connectorHealth";

const mk = (name: string, connected: boolean): McpServer => ({
  name,
  info: connected ? "✔ Connected" : "! Needs authentication",
  connected,
});

// Typical `claude mcp list` shape: a capability can have a LIVE server
// plus a stale duplicate registered under a sibling name. This is the
// situation that produces a false "not connected" claim when matching
// on one literal name.
const WITH_DUPLICATES: McpServer[] = [
  mk("claude.ai Glean", true),
  mk("glean", false), // stale duplicate — needs auth
  mk("google-workspace", true),
  mk("claude.ai Google Calendar", true),
  mk("slack-mcp", true),
  mk("claude.ai Slack", false), // stale duplicate
  mk("claude.ai Atlassian", true),
  mk("datadog-mcp", true),
];

describe("deriveConnectorHealth — alias tolerance (the false-negative fix)", () => {
  it("reports healthy when the live variant is connected even though a duplicate is not", () => {
    const health = deriveConnectorHealth(WITH_DUPLICATES);
    expect(health.healthy).toBe(true);
    expect(health.degraded).toEqual([]);
    expect(health.notConfigured).toEqual([]);
  });

  it("a capability is satisfied by whichever alias server is connected", () => {
    const caps = deriveConnectorHealth(WITH_DUPLICATES).capabilities;
    const glean = caps.find((c) => c.key === "glean")!;
    expect(glean.connected).toBe(true);
    expect(glean.via).toBe("claude.ai Glean");
    const slack = caps.find((c) => c.key === "slack")!;
    expect(slack.connected).toBe(true);
    expect(slack.via).toBe("slack-mcp");
  });

  it("flags a capability that is configured but genuinely down", () => {
    const noGlean = WITH_DUPLICATES.map((s) =>
      s.name === "claude.ai Glean" ? mk(s.name, false) : s,
    );
    const health = deriveConnectorHealth(noGlean);
    expect(health.healthy).toBe(false);
    expect(health.degraded).toEqual(["Glean"]);
    const glean = health.capabilities.find((c) => c.key === "glean")!;
    // still "present" (the servers exist) but not connected
    expect(glean.present).toBe(true);
    expect(glean.connected).toBe(false);
  });

  it("a capability with no matching server is 'not configured', not degraded", () => {
    const noSlack = WITH_DUPLICATES.filter(
      (s) => !s.name.toLowerCase().includes("slack"),
    );
    const health = deriveConnectorHealth(noSlack);
    expect(health.healthy).toBe(true);
    expect(health.degraded).toEqual([]);
    expect(health.notConfigured).toEqual(["Slack"]);
  });

  it("an empty list reports everything as not configured (and nothing as down)", () => {
    const health = deriveConnectorHealth([]);
    expect(health.healthy).toBe(true);
    expect(health.degraded).toEqual([]);
    expect(health.notConfigured.sort()).toEqual(
      ["Glean", "Google Workspace", "Slack"].sort(),
    );
    for (const c of health.capabilities) expect(c.present).toBe(false);
  });
});

describe("matchesCapability / isCapabilityServer", () => {
  it("matches case-insensitively on substring", () => {
    expect(matchesCapability("claude.ai Glean", ["glean"])).toBe(true);
    expect(matchesCapability("GOOGLE-WORKSPACE", ["google-workspace"])).toBe(true);
    expect(matchesCapability("datadog-mcp", ["glean"])).toBe(false);
  });

  it("absorbs capability servers (and their duplicates) out of Other MCPs", () => {
    expect(isCapabilityServer("claude.ai Glean")).toBe(true);
    expect(isCapabilityServer("glean")).toBe(true);
    expect(isCapabilityServer("claude.ai Slack")).toBe(true);
    expect(isCapabilityServer("datadog-mcp")).toBe(false);
  });
});
