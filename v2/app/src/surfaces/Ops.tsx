import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

import {
  isMineByKeywords,
  OPS_PREFS_CHANGED,
  readOpsPrefs,
  resolveMyPolicyKeywords,
} from "../state/opsPrefs";
import { runSkill, useRun } from "../state/skillRuns";
import { showToast } from "../state/toasts";
import { SurfaceHero } from "../ui";
import { type PersonRef } from "./People";
import { type ProfileTarget } from "./PersonProfile";

/** Mirrors `claude::McpServer`. The Ops surface uses this to tag
 *  each tab's empty state with whether the MCP it depends on looks
 *  configured + connected. */
export type McpServer = { name: string; info: string; connected: boolean };

/** Match a registered MCP by partial-name, case-insensitive. We
 *  match on substring because users can name their MCPs anything
 *  (e.g. `datadog-mcp`, `dd-prod`); we look for the brand keyword. */
export function findMcp(
  servers: McpServer[] | null,
  needle: string,
): McpServer | null {
  if (!servers) return null;
  const n = needle.toLowerCase();
  return servers.find((s) => s.name.toLowerCase().includes(n)) ?? null;
}

/** Tag an MCP for the empty-state copy: "ok" / "missing" / "broken". */
export function mcpStatus(s: McpServer | null): "ok" | "missing" | "broken" {
  if (!s) return "missing";
  return s.connected ? "ok" : "broken";
}

/** Surface-level "refresh everything" event. Each tab listens and
 *  fires its own refresh; the surface fires the event from a single
 *  toolbar button so the user doesn't have to visit every tab. */
export const OPS_REFRESH_ALL = "cos:ops-refresh-all";

/** B9-CP23 — full-stack morning sweep. Different from OPS_REFRESH_ALL:
 *  this fires every Ops + Velocity + Roadmap + Jira refresh in one go,
 *  for a 9 AM "what changed overnight" pulse. Listeners live on each
 *  surface that owns a fetcher. */
export const MORNING_SWEEP = "cos:morning-sweep";

export type OpsTab = "health" | "incidents" | "oncall";

const TABS: readonly { id: OpsTab; label: string }[] = [
  { id: "health", label: "Health" },
  { id: "incidents", label: "Incidents" },
  { id: "oncall", label: "On-call" },
] as const;

const OPS_TAB_KEY = "cos:ops-tab";
function readPersisted(): OpsTab {
  const raw = sessionStorage.getItem(OPS_TAB_KEY);
  if (raw === "health" || raw === "incidents" || raw === "oncall") return raw;
  return "incidents";
}

/**
 * Ops surface (PRD-108). Three tabs, each backed by a different
 * MCP-driven skill. Each tab's empty state reflects whether its
 * upstream MCP looks configured + connected (B8-CP15) so the user
 * knows whether the integration is the missing piece.
 */
export function Ops({
  onGoToProfile,
}: {
  /** Optional — when provided, the On-call tab uses this to deep-link
   *  from a PD on-call user into their Person Profile (when we can
   *  match by name). */
  onGoToProfile?: (target: ProfileTarget) => void;
} = {}) {
  const [tab, setTab] = useState<OpsTab>(() => readPersisted());
  useEffect(() => {
    sessionStorage.setItem(OPS_TAB_KEY, tab);
  }, [tab]);

  // B8-CP38 — `[` / `]` cycle Ops tabs (same behaviour as Work).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== "[" && e.key !== "]") return;
      const t = document.activeElement;
      if (
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        (t instanceof HTMLElement && t.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      const ix = TABS.findIndex((x) => x.id === tab);
      const delta = e.key === "]" ? 1 : -1;
      const next = TABS[(ix + delta + TABS.length) % TABS.length];
      setTab(next.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab]);

  // Snapshot of registered MCPs. We don't auto-refresh — Ops opens
  // and reads once; the user re-opens the tab to refresh, or hits
  // Refresh once CP20 lands.
  const [mcpServers, setMcpServers] = useState<McpServer[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    invoke<McpServer[]>("claude_mcp_list")
      .then((rows) => {
        if (!cancelled) setMcpServers(rows);
      })
      .catch(() => {
        if (!cancelled) setMcpServers([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="cos-ops">
      <SurfaceHero
        title="Ops"
        subtitle="Health, incidents, on-call. The view a manager opens to answer 'is anything on fire I don't know about?'"
        actions={
          <>
            <button
              type="button"
              className="cos-btn cos-btn-ghost"
              onClick={() => {
                window.dispatchEvent(new CustomEvent(OPS_REFRESH_ALL));
                showToast({
                  kind: "info",
                  text: "Refreshing all Ops snapshots…",
                  durationMs: 2500,
                });
              }}
            >
              Refresh all
            </button>
            <button
              type="button"
              className="cos-btn"
              onClick={() => {
                window.dispatchEvent(new CustomEvent(MORNING_SWEEP));
                showToast({
                  kind: "info",
                  text: "Morning sweep — refreshing every snapshot…",
                  durationMs: 3000,
                });
              }}
              title="Refresh Ops + Velocity + Roadmap + Jira in one go"
            >
              Morning sweep
            </button>
          </>
        }
      />
      <div className="cos-tabs cos-ops-tabs" role="tablist" aria-label="Ops view">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`cos-tab${tab === t.id ? " is-active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "health" && <HealthTab mcpServers={mcpServers} />}
      {tab === "incidents" && <IncidentsTab mcpServers={mcpServers} />}
      {tab === "oncall" && <OnCallTab onGoToProfile={onGoToProfile} />}
      {/* onGoToProfile threaded for forward-compat (B9-CP36) */}
    </div>
  );
}

/**
 * Render a small "MCP status" line. Three states:
 *   - ok       → green-ish: integration is connected, ready to query
 *   - broken   → amber: integration is registered but not connected
 *   - missing  → muted: not registered with this user's claude install
 */
function McpStatusLine({
  servers,
  needle,
  brand,
  hint,
}: {
  servers: McpServer[] | null;
  needle: string;
  brand: string;
  hint: string;
}) {
  if (servers === null) {
    return <p className="cos-pending">Probing MCP registration…</p>;
  }
  const match = findMcp(servers, needle);
  const status = mcpStatus(match);
  if (status === "ok") {
    return (
      <p className="cos-ops-mcp">
        <span className="cos-ci-dot cos-ci-green" aria-hidden /> {brand} MCP
        connected via <code>{match!.name}</code>
      </p>
    );
  }
  if (status === "broken") {
    return (
      <p className="cos-ops-mcp">
        <span className="cos-ci-dot cos-ci-yellow" aria-hidden /> {brand} MCP
        registered (<code>{match!.name}</code>) but not connected. {hint}
      </p>
    );
  }
  return (
    <p className="cos-ops-mcp">
      <span className="cos-ci-dot cos-ci-unknown" aria-hidden /> {brand} MCP
      not registered. {hint}
    </p>
  );
}

type RollbarItem = {
  id?: string;
  title: string;
  level?: string;
  occurrences?: number;
  project?: string;
  url?: string;
  status?: string;
};

type MonitorItem = {
  id?: number;
  name: string;
  state?: string;
  type?: string;
  tags?: string[];
  url?: string;
  modified?: string;
};

/** B9-CP26 — Recent deploys feed. Reads from opsPrefs.recentDeploys
 *  (configured in Settings → Ops). Phase-0 placeholder until the
 *  Compass adapter lands. Hidden when no deploys are configured. */
function RecentDeploys() {
  const [deploys, setDeploys] = useState<
    { service: string; url?: string; at?: string; note?: string }[]
  >([]);
  useEffect(() => {
    try {
      const raw = localStorage.getItem("cos:ops-prefs");
      if (!raw) return;
      const parsed = JSON.parse(raw) as {
        recentDeploys?: typeof deploys;
      };
      setDeploys(parsed.recentDeploys ?? []);
    } catch {
      // ignore
    }
  }, []);
  if (deploys.length === 0) return null;
  return (
    <section className="cos-ops-section">
      <header className="cos-section-head">
        <h3>Recent deploys</h3>
        <p className="cos-section-lede">
          Manual config (Settings → Ops). Replaced by the Compass /
          deploy-feed adapter post-B9.
        </p>
      </header>
      <ul className="cos-rollbar-list">
        {deploys.slice(0, 10).map((d, ix) => (
          <li key={`${d.service}-${ix}`}>
            <button
              type="button"
              className="cos-rollbar-row"
              onClick={() => {
                if (d.url) openUrl(d.url).catch(() => {});
              }}
              disabled={!d.url}
            >
              <div className="cos-rollbar-head">
                <span className="cos-rollbar-count">{d.service}</span>
                {d.at && <span className="cos-rollbar-project">{d.at}</span>}
              </div>
              {d.note && <div className="cos-rollbar-title">{d.note}</div>}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function HealthTab({ mcpServers }: { mcpServers: McpServer[] | null }) {
  const [rollbar, setRollbar] = useState<{
    fetched_at?: string | null;
    items: RollbarItem[];
    mcp_error?: string;
  } | null>(null);
  const [monitors, setMonitors] = useState<{
    fetched_at?: string | null;
    monitors: MonitorItem[];
    mcp_error?: string;
  } | null>(null);
  // B9-CP25 — drill-down lookups. We pivot on the service slug
  // (extracted from a tag like "service:foo" or the project name)
  // and surface related rows from the same snapshot without an
  // extra fetch.
  const [drillService, setDrillService] = useState<string | null>(null);

  const rollbarRun = useRun("ops-rollbar-top");
  const monitorsRun = useRun("ops-datadog-monitors");
  const rollbarBusy = rollbarRun?.state === "running";
  const monitorsBusy = monitorsRun?.state === "running";

  useEffect(() => {
    invoke<typeof rollbar>("ops_rollbar_read").then(setRollbar).catch(() => {});
    invoke<typeof monitors>("ops_monitors_read").then(setMonitors).catch(() => {});
  }, []);

  useEffect(() => {
    const onAll = () => {
      refreshRollbar();
      refreshMonitors();
    };
    window.addEventListener(OPS_REFRESH_ALL, onAll);
    window.addEventListener(MORNING_SWEEP, onAll);
    return () => {
      window.removeEventListener(OPS_REFRESH_ALL, onAll);
      window.removeEventListener(MORNING_SWEEP, onAll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshRollbar = () =>
    runSkill("ops-rollbar-top", "Refresh Rollbar", async () => {
      const v = await invoke<typeof rollbar>("ops_rollbar_run");
      setRollbar(v);
      return v;
    }).catch((err) => {
      showToast({ kind: "error", text: `Rollbar: ${String(err)}`, durationMs: 6000 });
    });

  const refreshMonitors = () =>
    runSkill("ops-datadog-monitors", "Refresh monitors", async () => {
      const v = await invoke<typeof monitors>("ops_monitors_run");
      setMonitors(v);
      return v;
    }).catch((err) => {
      showToast({
        kind: "error",
        text: `Monitors: ${String(err)}`,
        durationMs: 6000,
      });
    });

  // B9-CP25 — derive related items for the drill-down. Rollbar
  // matches by project; monitors match by service:* tag.
  const relatedRollbar =
    drillService && rollbar
      ? rollbar.items.filter(
          (it) => (it.project ?? "").toLowerCase() === drillService.toLowerCase(),
        )
      : [];
  const relatedMonitors =
    drillService && monitors
      ? monitors.monitors.filter((m) =>
          (m.tags ?? []).some(
            (t) =>
              t.toLowerCase() === `service:${drillService.toLowerCase()}` ||
              t.toLowerCase() === drillService.toLowerCase(),
          ),
        )
      : [];

  return (
    <div className="cos-ops-pane">
      <header className="cos-section-head">
        <h2>Service health</h2>
        <p className="cos-section-lede">
          Rollbar top items + Datadog monitor failures for the services
          your team owns. Click a row's service tag to drill down.
        </p>
      </header>
      {drillService && (
        <section className="cos-ops-drilldown">
          <header className="cos-section-head">
            <h3>
              Drill-down · <code>{drillService}</code>
            </h3>
          </header>
          <p className="cos-helper-text">
            {relatedRollbar.length} Rollbar item
            {relatedRollbar.length === 1 ? "" : "s"} · {relatedMonitors.length}{" "}
            monitor{relatedMonitors.length === 1 ? "" : "s"} on this service.
          </p>
          <button
            type="button"
            className="cos-btn cos-btn-ghost"
            onClick={() => setDrillService(null)}
          >
            Close drill-down
          </button>
        </section>
      )}

      <section className="cos-ops-section">
        <header className="cos-section-head">
          <h3>Rollbar — top items (7d)</h3>
        </header>
        <McpStatusLine
          servers={mcpServers}
          needle="rollbar"
          brand="Rollbar"
          hint="Add the Rollbar MCP via Claude Code config."
        />
        <div className="cos-prs-controls">
          <button
            type="button"
            className="cos-btn cos-btn-ghost"
            onClick={refreshRollbar}
            disabled={rollbarBusy}
          >
            {rollbarBusy ? "Fetching…" : "Refresh"}
          </button>
          {rollbar?.fetched_at && (
            <span className="cos-prs-fetched">
              fetched {formatRelative(rollbar.fetched_at)}
            </span>
          )}
        </div>
        {rollbar?.mcp_error && (
          <p className="cos-bad">MCP error: {rollbar.mcp_error}</p>
        )}
        {(!rollbar || rollbar.items.length === 0) && (
          <div className="cos-empty">
            <p>
              {rollbar?.fetched_at
                ? "No active items in the last 7 days."
                : "No snapshot yet — click Refresh."}
            </p>
          </div>
        )}
        {rollbar && rollbar.items.length > 0 && (
          <ul className="cos-rollbar-list">
            {rollbar.items.slice(0, 10).map((it, ix) => (
              <li key={it.id ?? `${it.title}-${ix}`}>
                <button
                  type="button"
                  className={`cos-rollbar-row cos-rollbar-${(
                    it.level ?? "error"
                  ).toLowerCase()}`}
                  onClick={() => {
                    if (it.url) openUrl(it.url).catch(() => {});
                  }}
                  disabled={!it.url}
                >
                  <div className="cos-rollbar-head">
                    <span className="cos-rollbar-count">
                      {it.occurrences ?? 0}×
                    </span>
                    <span className="cos-rollbar-project">{it.project ?? ""}</span>
                    {it.status && (
                      <span className="cos-chip cos-chip-muted">{it.status}</span>
                    )}
                  </div>
                  <div className="cos-rollbar-title">{it.title}</div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <RecentDeploys />

      <section className="cos-ops-section">
        <header className="cos-section-head">
          <h3>Datadog — failing monitors</h3>
        </header>
        <McpStatusLine
          servers={mcpServers}
          needle="datadog"
          brand="Datadog"
          hint="Add the Datadog MCP via Claude Code config."
        />
        <div className="cos-prs-controls">
          <button
            type="button"
            className="cos-btn cos-btn-ghost"
            onClick={refreshMonitors}
            disabled={monitorsBusy}
          >
            {monitorsBusy ? "Fetching…" : "Refresh"}
          </button>
          {monitors?.fetched_at && (
            <span className="cos-prs-fetched">
              fetched {formatRelative(monitors.fetched_at)}
            </span>
          )}
        </div>
        {monitors?.mcp_error && (
          <p className="cos-bad">MCP error: {monitors.mcp_error}</p>
        )}
        {(!monitors || monitors.monitors.length === 0) && (
          <div className="cos-empty">
            <p>
              {monitors?.fetched_at
                ? "No monitors are failing. Quiet."
                : "No snapshot yet — click Refresh."}
            </p>
          </div>
        )}
        {monitors && monitors.monitors.length > 0 && (
          <ul className="cos-monitor-list">
            {monitors.monitors.slice(0, 15).map((m, ix) => (
              <li key={m.id ?? `${m.name}-${ix}`}>
                <button
                  type="button"
                  className={`cos-monitor-row cos-monitor-${(
                    m.state ?? "unknown"
                  )
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, "-")}`}
                  onClick={() => {
                    if (m.url) openUrl(m.url).catch(() => {});
                  }}
                  disabled={!m.url}
                >
                  <div className="cos-monitor-head">
                    <span className="cos-monitor-state">{m.state ?? "?"}</span>
                    <span className="cos-monitor-name">{m.name}</span>
                  </div>
                  {m.tags && m.tags.length > 0 && (
                    <div className="cos-monitor-tags">
                      {m.tags.slice(0, 4).join(", ")}
                    </div>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

type IncidentRelevance = "mine" | "adjacent" | "unrelated";

type Incident = {
  id?: string;
  title: string;
  severity?: string;
  state?: string;
  created_at?: string;
  /** Most-recent thread reply ts. Falls back to created_at when the
   *  skill writes an old-shape snapshot (pre-B9-CP11). */
  last_updated_at?: string;
  url?: string;
  /** Resolved display name from /ops-incidents post-B9-CP11. Earlier
   *  snapshots wrote the raw `<@U…>` Slack mention; the UI detects
   *  that and hides it until the next refresh resolves the name. */
  commander?: string;
  commander_id?: string;
  team?: string;
  /** One-line current-status synthesis from the latest thread
   *  reply. Used as a subtitle so a manager can scan "what is
   *  this incident doing right now?" without clicking through. */
  summary?: string;
  /** Short chips that explain why an incident is `mine`/`adjacent`
   *  ("payments", "@alice", "core"). Empty when the skill found
   *  nothing meaningful. */
  tags?: string[];
  /** Set by /ops-incidents using CLAUDE.md context. Drives the
   *  row's background tint orthogonal to severity. */
  relevance?: IncidentRelevance;
};

const SLACK_USER_MENTION = /^<@U[A-Z0-9]+>$/;

type IncidentsPayload = {
  fetched_at: string | null;
  incidents: Incident[];
  missing?: boolean;
  mcp_error?: string;
};

function IncidentsTab({ mcpServers }: { mcpServers: McpServer[] | null }) {
  const [payload, setPayload] = useState<IncidentsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useRun("ops-incidents");
  const refreshing = run?.state === "running";

  const readSnapshot = useCallback(async () => {
    try {
      const v = await invoke<IncidentsPayload>("ops_incidents_read");
      setPayload(v);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    readSnapshot();
  }, [readSnapshot]);

  // B8-CP20 — surface-level refresh-all event.
  useEffect(() => {
    const onAll = () => triggerRun();
    window.addEventListener(OPS_REFRESH_ALL, onAll);
    window.addEventListener(MORNING_SWEEP, onAll);
    return () => {
      window.removeEventListener(OPS_REFRESH_ALL, onAll);
      window.removeEventListener(MORNING_SWEEP, onAll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const triggerRun = () => {
    if (refreshing) return;
    runSkill("ops-incidents", "Refresh incidents", async () => {
      const v = await invoke<IncidentsPayload>("ops_incidents_run");
      setPayload(v);
      return v;
    }).catch((err) => {
      showToast({
        kind: "error",
        text: `Could not refresh incidents: ${String(err)}`,
        durationMs: 6000,
      });
    });
  };

  const incidents = payload?.incidents ?? [];
  const fetchedAt = payload?.fetched_at ?? null;

  return (
    <div className="cos-ops-pane">
      <header className="cos-section-head">
        <h2>Active incidents</h2>
        <p className="cos-section-lede">
          Active SEV-1/SEV-2 incidents declared in your org's
          <code>#incidents</code> Slack channel. The list a manager
          scans first thing in the morning.
        </p>
      </header>
      <McpStatusLine
        servers={mcpServers}
        needle="slack"
        brand="Slack"
        hint="/ops-incidents reads your `#incidents` Slack channel by default. If your org uses Datadog Incidents, PagerDuty, FireHydrant, or another tool, adapt the skill to that source. Configure the Slack MCP in your Claude Code settings."
      />
      {payload?.mcp_error && (
        <p className="cos-bad">MCP error: {payload.mcp_error}</p>
      )}
      <div className="cos-prs-controls">
        <button
          type="button"
          className="cos-btn cos-btn-ghost"
          onClick={triggerRun}
          disabled={refreshing}
        >
          {refreshing ? "Fetching…" : "Refresh"}
        </button>
        {fetchedAt && (
          <span className="cos-prs-fetched">
            fetched {formatRelative(fetchedAt)}
          </span>
        )}
      </div>
      {error && <p className="cos-bad">{error}</p>}
      {incidents.length === 0 && !error && (
        <div className="cos-empty">
          <p>
            {fetchedAt
              ? "No active incidents. Quiet day."
              : "No snapshot yet — click Refresh to run /ops-incidents."}
          </p>
        </div>
      )}
      {incidents.length > 0 && (
        <ul className="cos-incident-list">
          {incidents.map((i, ix) => {
            const sevSlug = (i.severity ?? "sev-3")
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-");
            const relevance = i.relevance ?? "unrelated";
            const tags = i.tags ?? [];
            // Hide raw `<@U…>` mentions from snapshots written before
            // the skill resolved Slack IDs to display names.
            const commanderDisplay =
              i.commander && !SLACK_USER_MENTION.test(i.commander)
                ? i.commander
                : null;
            const updatedAt = i.last_updated_at ?? null;
            // Only show "updated" when it's meaningfully different
            // from "opened" — within ~2 minutes they're effectively
            // the same event and the chip becomes noise.
            const showUpdated =
              updatedAt &&
              i.created_at &&
              Math.abs(Date.parse(updatedAt) - Date.parse(i.created_at)) >
                2 * 60_000;
            return (
              <li key={i.id ?? `${i.title}-${ix}`}>
                <button
                  type="button"
                  className={`cos-incident-row cos-incident-${sevSlug} cos-incident-rel-${relevance}`}
                  onClick={() => {
                    if (i.url)
                      openUrl(i.url).catch(() => {
                        /* per-row failure surfaces in toast */
                      });
                  }}
                  disabled={!i.url}
                  title={i.url ?? ""}
                >
                  <div className="cos-incident-head">
                    <span className="cos-incident-sev">
                      {i.severity ?? "?"}
                    </span>
                    <span className="cos-incident-state">
                      {i.state ?? "—"}
                    </span>
                    {relevance !== "unrelated" && (
                      <span
                        className={`cos-chip cos-incident-rel-chip cos-incident-rel-chip-${relevance}`}
                      >
                        {relevance === "mine" ? "mine" : "adjacent"}
                      </span>
                    )}
                    {tags.map((tag) => (
                      <span
                        key={tag}
                        className="cos-chip cos-incident-tag"
                      >
                        {tag}
                      </span>
                    ))}
                    {i.team && (
                      <span className="cos-chip cos-chip-info">{i.team}</span>
                    )}
                  </div>
                  <div className="cos-incident-title">{i.title}</div>
                  {i.summary && (
                    <div className="cos-incident-summary">{i.summary}</div>
                  )}
                  <div className="cos-incident-meta">
                    {i.created_at && (
                      <span>opened {formatRelative(i.created_at)}</span>
                    )}
                    {showUpdated && (
                      <>
                        <span aria-hidden> · </span>
                        <span>updated {formatRelative(updatedAt!)}</span>
                      </>
                    )}
                    {commanderDisplay && (
                      <>
                        <span aria-hidden> · </span>
                        <span>commander {commanderDisplay}</span>
                      </>
                    )}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function formatRelative(iso: string): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const ms = Date.now() - t;
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(t).toLocaleDateString();
}

type OncallEntry = {
  policy_id: string;
  policy_name: string;
  level: number;
  user_id: string;
  user_name: string;
  schedule_id: string | null;
  schedule_name: string | null;
  end: string | null;
  user_url: string;
};

const ONCALL_SEARCH_KEY = "cos:oncall-search";
const ONCALL_OTHER_EXPANDED_KEY = "cos:oncall-other-expanded";

type OncallGroup = {
  policyId: string;
  policyName: string;
  entries: OncallEntry[];
  mine: boolean;
};

function OnCallTab({
  onGoToProfile,
}: {
  onGoToProfile?: (target: ProfileTarget) => void;
} = {}) {
  const [rows, setRows] = useState<OncallEntry[]>([]);
  const [load, setLoad] = useState<"idle" | "loading" | "ok" | "error">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const [hasToken, setHasToken] = useState<boolean | null>(null);
  const [search, setSearch] = useState(
    () => sessionStorage.getItem(ONCALL_SEARCH_KEY) ?? "",
  );
  const [keywords, setKeywords] = useState<string[]>(() =>
    resolveMyPolicyKeywords(readOpsPrefs()),
  );
  const [people, setPeople] = useState<PersonRef[] | null>(null);
  const [otherExpanded, setOtherExpanded] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(ONCALL_OTHER_EXPANDED_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    sessionStorage.setItem(ONCALL_SEARCH_KEY, search);
  }, [search]);

  useEffect(() => {
    try {
      sessionStorage.setItem(
        ONCALL_OTHER_EXPANDED_KEY,
        otherExpanded ? "1" : "0",
      );
    } catch {
      /* sessionStorage may be denied */
    }
  }, [otherExpanded]);

  // Re-classify when the user edits opsPrefs in Settings; lets the
  // section split flip without requiring a tab switch.
  useEffect(() => {
    const onChanged = () =>
      setKeywords(resolveMyPolicyKeywords(readOpsPrefs()));
    window.addEventListener(OPS_PREFS_CHANGED, onChanged);
    return () => window.removeEventListener(OPS_PREFS_CHANGED, onChanged);
  }, []);

  const fetchAll = useCallback(async () => {
    setLoad("loading");
    setError(null);
    try {
      const status = await invoke<{ has_token: boolean }>("paging_status", {
        probe: false,
      });
      setHasToken(status.has_token);
      if (!status.has_token) {
        setRows([]);
        setLoad("ok");
        return;
      }
      const r = await invoke<OncallEntry[]>("paging_oncall_now");
      setRows(r);
      setLoad("ok");
    } catch (err) {
      setError(String(err));
      setLoad("error");
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // Lazy-load the people index so we can deep-link an on-call user
  // into Person Profile when names match. Best-effort — failures are
  // silent and the row falls back to the PD URL.
  useEffect(() => {
    if (!onGoToProfile) return;
    let cancelled = false;
    invoke<PersonRef[]>("content_list_people")
      .then((list) => {
        if (!cancelled) setPeople(list);
      })
      .catch(() => {
        if (!cancelled) setPeople([]);
      });
    return () => {
      cancelled = true;
    };
  }, [onGoToProfile]);

  const personByName = useMemo(() => {
    const m = new Map<string, PersonRef>();
    for (const p of people ?? []) {
      m.set(p.label.toLowerCase().trim(), p);
    }
    return m;
  }, [people]);

  // PD doesn't surface the org subdomain on each row; derive it once
  // from any user_url so we can build escalation-policy + schedule
  // URLs without an extra round-trip.
  const pdHost = useMemo(() => {
    const u = rows.find((r) => r.user_url)?.user_url;
    if (!u) return null;
    try {
      return new URL(u).host;
    } catch {
      return null;
    }
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      const t = `${r.policy_name} • ${r.schedule_name ?? ""} • ${r.user_name}`.toLowerCase();
      return t.includes(q);
    });
  }, [rows, search]);

  const grouped = useMemo<OncallGroup[]>(() => {
    const map = new Map<string, OncallGroup>();
    for (const r of filtered) {
      let g = map.get(r.policy_id);
      if (!g) {
        g = {
          policyId: r.policy_id,
          policyName: r.policy_name,
          entries: [],
          mine: false,
        };
        map.set(r.policy_id, g);
      }
      g.entries.push(r);
    }
    for (const g of map.values()) {
      g.entries.sort((a, b) => a.level - b.level);
      // A policy counts as "mine" when any entry's policy / schedule /
      // user name hits a keyword. Schedules carry team tokens that
      // the policy name sometimes doesn't.
      g.mine = g.entries.some((r) =>
        isMineByKeywords(
          [g.policyName, r.schedule_name, r.user_name],
          keywords,
        ),
      );
    }
    return [...map.values()].sort((a, b) => {
      if (a.mine !== b.mine) return a.mine ? -1 : 1;
      return a.policyName.localeCompare(b.policyName);
    });
  }, [filtered, keywords]);

  const mineGroups = grouped.filter((g) => g.mine);
  const otherGroups = grouped.filter((g) => !g.mine);

  return (
    <div className="cos-ops-pane">
      <header className="cos-section-head">
        <h2>On-call</h2>
        <p className="cos-section-lede">
          Who's primary / secondary right now per escalation policy.
          PagerDuty REST API; PRD-108 §11.
        </p>
      </header>
      <div className="cos-prs-controls cos-oncall-controls">
        <button
          type="button"
          className="cos-btn cos-btn-ghost"
          onClick={fetchAll}
          disabled={load === "loading"}
        >
          {load === "loading" ? "Fetching…" : "Refresh"}
        </button>
        <input
          type="search"
          className="cos-text-input cos-oncall-search"
          placeholder="Search team, schedule, or person…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Filter on-call entries"
        />
        {keywords.length === 0 && (
          <span className="cos-helper-text cos-oncall-keywords-hint">
            Set &ldquo;On-call relevance&rdquo; in Settings → Ops to pin
            your teams at the top.
          </span>
        )}
      </div>
      {load === "error" && (
        <div className="cos-empty cos-empty-error">
          <p>Could not fetch on-call.</p>
          <p className="cos-helper-text">{error}</p>
          <button
            type="button"
            className="cos-btn cos-btn-ghost"
            onClick={() => {
              fetchAll();
              showToast({
                kind: "info",
                text: "Retrying on-call…",
                durationMs: 2500,
              });
            }}
          >
            Retry
          </button>
        </div>
      )}
      {hasToken === false && load === "ok" && (
        <div className="cos-empty">
          <p>No PagerDuty token configured.</p>
          <p className="cos-helper-text">
            Settings → Ops → On-call. PRD-108 §11 covers token setup.
          </p>
        </div>
      )}
      {hasToken && load === "ok" && rows.length === 0 && (
        <div className="cos-empty">
          <p>No on-call entries returned.</p>
          <p className="cos-helper-text">
            Either nothing's on-call right now or your token doesn't
            see any escalation policies. Confirm scope in Probe.
          </p>
        </div>
      )}
      {load === "ok" && rows.length > 0 && grouped.length === 0 && (
        <div className="cos-empty">
          <p>No matches for &ldquo;{search}&rdquo;.</p>
          <p className="cos-helper-text">
            Clear the search to see all entries.
          </p>
        </div>
      )}
      {load === "ok" && mineGroups.length > 0 && (
        <OnCallSection
          title="My teams"
          groups={mineGroups}
          pdHost={pdHost}
          personByName={personByName}
          onGoToProfile={onGoToProfile}
          variant="mine"
        />
      )}
      {load === "ok" && otherGroups.length > 0 && (
        <OnCallSection
          title={mineGroups.length > 0 ? "Other teams" : "Escalation policies"}
          groups={otherGroups}
          pdHost={pdHost}
          personByName={personByName}
          onGoToProfile={onGoToProfile}
          variant="other"
          collapsible={mineGroups.length > 0}
          collapsed={mineGroups.length > 0 && !otherExpanded}
          onToggle={() => setOtherExpanded((v) => !v)}
        />
      )}
    </div>
  );
}

function OnCallSection({
  title,
  groups,
  pdHost,
  personByName,
  onGoToProfile,
  variant,
  collapsible = false,
  collapsed = false,
  onToggle,
}: {
  title: string;
  groups: OncallGroup[];
  pdHost: string | null;
  personByName: Map<string, PersonRef>;
  onGoToProfile?: (target: ProfileTarget) => void;
  variant: "mine" | "other";
  collapsible?: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const countLabel = `${groups.length} ${groups.length === 1 ? "policy" : "policies"}`;
  return (
    <section className={`cos-oncall-section cos-oncall-section-${variant}`}>
      {collapsible ? (
        <header className="cos-oncall-section-head">
          <button
            type="button"
            className="cos-oncall-section-toggle"
            onClick={onToggle}
            aria-expanded={!collapsed}
          >
            <span aria-hidden>{collapsed ? "▸" : "▾"}</span>
            <h3>{title}</h3>
            <span className="cos-helper-text">{countLabel}</span>
          </button>
        </header>
      ) : (
        <header className="cos-oncall-section-head">
          <h3>{title}</h3>
          <span className="cos-helper-text">{countLabel}</span>
        </header>
      )}
      {collapsed ? null : (
      <ul className="cos-oncall-list" aria-label={title}>
        {groups.map((g) => {
          const policyUrl = pdHost
            ? `https://${pdHost}/escalation_policies/${g.policyId}`
            : null;
          return (
            <li key={g.policyId} className="cos-oncall-policy">
              <div className="cos-oncall-policy-head">
                {policyUrl ? (
                  <button
                    type="button"
                    className="cos-oncall-policy-link"
                    onClick={() => openUrl(policyUrl).catch(() => {})}
                    title="Open escalation policy in PagerDuty"
                    aria-label={`Open ${g.policyName} in PagerDuty`}
                  >
                    {g.policyName}
                    <span aria-hidden> ↗</span>
                  </button>
                ) : (
                  <span>{g.policyName}</span>
                )}
              </div>
              <ul
                className="cos-oncall-users"
                aria-label={`Users on ${g.policyName}`}
              >
                {g.entries.map((r) => (
                  <OnCallRow
                    key={`${r.user_id}-${r.level}`}
                    entry={r}
                    pdHost={pdHost}
                    person={personByName.get(
                      r.user_name.toLowerCase().trim(),
                    )}
                    onGoToProfile={onGoToProfile}
                  />
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
      )}
    </section>
  );
}

function OnCallRow({
  entry,
  pdHost,
  person,
  onGoToProfile,
}: {
  entry: OncallEntry;
  pdHost: string | null;
  person?: PersonRef;
  onGoToProfile?: (target: ProfileTarget) => void;
}) {
  const scheduleUrl =
    pdHost && entry.schedule_id
      ? `https://${pdHost}/schedules/${entry.schedule_id}`
      : null;
  const canGoToProfile = !!person && !!onGoToProfile;
  const handlePrimary = () => {
    if (person && onGoToProfile) {
      onGoToProfile({
        slug: person.slug,
        label: person.label,
        rel_path: person.rel_path,
      });
      return;
    }
    if (entry.user_url) openUrl(entry.user_url).catch(() => {});
  };
  return (
    <li className="cos-oncall-row">
      <button
        type="button"
        className="cos-oncall-row-main"
        aria-label={
          canGoToProfile
            ? `Open ${entry.user_name}'s profile`
            : `Open PagerDuty profile for ${entry.user_name}, level ${entry.level}`
        }
        onClick={handlePrimary}
      >
        <span
          className={`cos-oncall-level cos-oncall-level-${entry.level}`}
        >
          L{entry.level}
        </span>
        <span className="cos-oncall-user">{entry.user_name}</span>
        {canGoToProfile && (
          <span className="cos-chip cos-chip-muted cos-oncall-profile-hint">
            profile
          </span>
        )}
      </button>
      {entry.schedule_name && scheduleUrl && (
        <button
          type="button"
          className="cos-chip cos-chip-muted cos-oncall-schedule-link"
          onClick={() => openUrl(scheduleUrl).catch(() => {})}
          title="Open schedule in PagerDuty"
        >
          {entry.schedule_name}
          <span aria-hidden> ↗</span>
        </button>
      )}
      {entry.schedule_name && !scheduleUrl && (
        <span className="cos-chip cos-chip-muted">{entry.schedule_name}</span>
      )}
      {entry.end && (
        <span className="cos-chip cos-oncall-until">
          ends {formatRelative(entry.end)}
        </span>
      )}
      {canGoToProfile && entry.user_url && (
        <button
          type="button"
          className="cos-oncall-pd-link"
          onClick={() => openUrl(entry.user_url).catch(() => {})}
          title="Open in PagerDuty"
          aria-label={`Open ${entry.user_name} in PagerDuty`}
        >
          PD <span aria-hidden>↗</span>
        </button>
      )}
    </li>
  );
}

// Re-exported for the palette / shortcut handler.
export { TABS as OPS_TABS };
