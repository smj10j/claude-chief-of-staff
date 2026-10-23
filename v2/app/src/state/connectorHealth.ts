/**
 * Connector health — shared, alias-tolerant derivation of whether the
 * MCP capabilities the CoS skills depend on (Glean, Google Workspace,
 * Slack) are actually reachable.
 *
 * Why alias-tolerant: the same capability is often registered under
 * more than one server name — a hosted connector alongside a local
 * server, or a plugin-provided copy of one you added yourself — and it's
 * common for one of them to be live while a stale duplicate reports
 * "needs authentication". Matching a capability to a single literal
 * name reports the live capability as DOWN — the exact false-negative
 * this module removes. A capability is healthy if ANY of its alias
 * servers is connected.
 *
 * Capabilities you haven't configured at all are optional: they show as
 * "not configured" and never count as a failure. Only a capability that
 * is configured but not connected is degraded.
 *
 * This mirrors the `bash bin/cos connectors` CLI check (its default
 * capability list) so the desktop red dot and the terminal/agent ground
 * truth stay in agreement.
 */

export type McpServer = { name: string; info: string; connected: boolean };

export type ConnectorCapability = {
  key: string;
  label: string;
  /** Purpose blurb (shown in Settings). */
  purpose: string;
  /**
   * Case-insensitive substrings. A server satisfies the capability if
   * its name contains any of these. Order is priority for display.
   */
  aliases: string[];
};

/**
 * The three capabilities the v2 skills lean on hardest. Keep this in
 * lockstep with the default `COS_CRITICAL_CONNECTORS` list in
 * `bin/cos connectors`.
 */
export const CONNECTOR_CAPABILITIES: ConnectorCapability[] = [
  {
    key: "glean",
    label: "Glean",
    purpose: "Cross-source search (Slack + Confluence + Drive) for org lookups.",
    aliases: ["glean"],
  },
  {
    key: "google-workspace",
    label: "Google Workspace",
    purpose: "Calendar + Docs + Sheets for prep and scheduling.",
    aliases: ["google-workspace", "google calendar", "google drive"],
  },
  {
    key: "slack",
    label: "Slack",
    purpose: "Search + read Slack to infer who works with whom.",
    aliases: ["slack"],
  },
];

export type CapabilityStatus = {
  key: string;
  label: string;
  purpose: string;
  /** At least one alias server is connected. */
  connected: boolean;
  /** At least one alias server exists in the list (connected or not). */
  present: boolean;
  /** The connected server name that satisfied the capability, if any. */
  via: string | null;
};

export type ConnectorHealth = {
  /** True when no configured capability is down. Capabilities with no
   *  matching server at all are optional and never count against this. */
  healthy: boolean;
  capabilities: CapabilityStatus[];
  /** Labels of configured capabilities that are NOT connected. */
  degraded: string[];
  /** Labels of capabilities with no matching server configured. */
  notConfigured: string[];
};

/** Case-insensitive substring match of a server name against aliases. */
export function matchesCapability(serverName: string, aliases: string[]): boolean {
  const lower = serverName.toLowerCase();
  return aliases.some((a) => lower.includes(a.toLowerCase()));
}

/** True when a server belongs to one of the tracked capabilities. Used
 *  to keep capability servers (and their duplicates) out of the
 *  "Other MCPs" list in Settings. */
export function isCapabilityServer(serverName: string): boolean {
  return CONNECTOR_CAPABILITIES.some((cap) =>
    matchesCapability(serverName, cap.aliases),
  );
}

/**
 * Derive capability-level health from a `claude mcp list` result.
 * A capability is connected if ANY of its alias servers is connected;
 * `via` reports which live server satisfied it.
 */
export function deriveConnectorHealth(servers: McpServer[]): ConnectorHealth {
  const capabilities: CapabilityStatus[] = CONNECTOR_CAPABILITIES.map((cap) => {
    const hit = servers.find(
      (s) => s.connected && matchesCapability(s.name, cap.aliases),
    );
    const present = servers.some((s) => matchesCapability(s.name, cap.aliases));
    return {
      key: cap.key,
      label: cap.label,
      purpose: cap.purpose,
      connected: Boolean(hit),
      present,
      via: hit ? hit.name : null,
    };
  });
  const degraded = capabilities
    .filter((c) => c.present && !c.connected)
    .map((c) => c.label);
  const notConfigured = capabilities
    .filter((c) => !c.present)
    .map((c) => c.label);
  return {
    healthy: degraded.length === 0,
    capabilities,
    degraded,
    notConfigured,
  };
}
