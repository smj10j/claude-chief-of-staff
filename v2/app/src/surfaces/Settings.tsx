import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { invoke } from "@tauri-apps/api/core";

import {
  applyAccentOverride,
  applyTextScale,
  applyTheme,
  clampTextScale,
  DEFAULT_TEXT_SCALE,
  MAX_TEXT_SCALE,
  MIN_TEXT_SCALE,
  normalizeAccentHex,
  readAccentOverride,
  readTextScale,
  readTheme,
  TEXT_SCALE_STEP,
  THEMES,
  writeAccentOverride,
  writeTextScale,
  writeTheme,
} from "../theme/registry";
import {
  readToolbarDensity,
  writeToolbarDensity,
  type ToolbarDensity,
} from "../editor/EditorToolbar";
import {
  readShowDeveloperSurfaces,
  writeShowDeveloperSurfaces,
} from "../state/developerSurfaces";
import {
  readSidebarRecentsMax,
  SIDEBAR_RECENTS_MAX_OPTIONS,
  writeSidebarRecentsMax,
  type SidebarRecentsMax,
} from "../state/recentDocs";
import {
  checkForUpdate,
  downloadAvailableUpdate,
  readAutoInstall,
  relaunchToInstall,
  useUpdateState,
  writeAutoInstall,
} from "../state/updater";

export type BackendInfo = {
  version: string;
  db_path: string;
  built_by: string;
  built_with: string;
};
export type PingResult = { rows: number; last_write: string };
type ClaudeCliConfig = {
  binary_path: string;
  settings_path: string;
  extra_args: string[];
};
type ClaudeCliStatus = {
  binary_path_configured: string;
  binary_path_resolved: string | null;
  settings_path: string;
  extra_args: string[];
  default_extra_args: string[];
  available: boolean;
  config_file: string;
};
type McpServer = { name: string; info: string; connected: boolean };

// MCPs the v2 skills will lean on the most. Used as the recommended list
// when nothing is connected; shown dimmed if configured but disconnected.
const RECOMMENDED_MCPS: { name: string; purpose: string }[] = [
  {
    name: "glean",
    purpose: "Cross-source search (Slack + Confluence + Drive) for org lookups.",
  },
  {
    name: "google-workspace",
    purpose: "Calendar + Docs + Sheets for prep and scheduling.",
  },
  {
    name: "slack-local-mcp",
    purpose: "Search + read Slack to infer who works with whom.",
  },
];
type AuditRow = {
  id: number;
  at: string;
  actor: string;
  action: string;
  target_kind: string;
  target_id: string;
  detail_json: string;
  this_hash: string;
};
type AuditVerification = { ok: boolean; broken_at: number | null };

/** Audit log pagination batch size (B7-CP24). 50 keeps the initial
 *  fetch fast; user can append with "load more". */
export const AUDIT_PAGE_SIZE = 50;

export type Status<T> =
  | { kind: "pending" }
  | { kind: "ok"; value: T }
  | { kind: "error"; error: string };

function render<T>(s: Status<T>, ok: (v: T) => string): ReactElement {
  if (s.kind === "pending") return <span className="cos-pending">waiting…</span>;
  if (s.kind === "error") return <span className="cos-bad">error: {s.error}</span>;
  return <span className="cos-good">ok · {ok(s.value)}</span>;
}

/**
 * Restore outcome shape returned by the audit_restore IPC. Mirrors the
 * Rust RestoreOutcome enum (snake_case via #[serde(rename_all)]).
 *   - restored: the file was actually rewritten with the before-state.
 *   - no_op: save_markdown's content-equal short-circuit fired (file
 *     was already at the before-state — usually a re-restore click).
 *   - create_row: this audit row was the file's first write; nothing
 *     to restore to.
 *   - blob_missing: before_hash exists but the snapshot blob isn't on
 *     disk. Pre-fix audit rows in git-tracked workspaces hit this —
 *     historical rows that predate the always-capture fix can never
 *     be restored from this app.
 */
export type RestoreOutcome =
  | { kind: "restored"; rel_path: string }
  | { kind: "no_op"; rel_path: string }
  | { kind: "create_row" }
  | { kind: "blob_missing" };

/**
 * UI status for the per-row restore button. "running" / "error" are
 * ephemeral; the four IPC outcomes above are sticky (persist across
 * mount/unmount via localStorage) so a sealed result doesn't re-arm
 * the button on tab switch.
 */
export type RestoreStatusValue =
  | { kind: "running" }
  | { kind: "error"; error: string }
  | RestoreOutcome;

const RESTORED_AUDIT_IDS_KEY = "cos.restored-audit-ids.v2";

type StoredEntry =
  | { id: number; outcome: "restored"; rel_path: string }
  | { id: number; outcome: "no_op"; rel_path: string }
  | { id: number; outcome: "create_row" }
  | { id: number; outcome: "blob_missing" };

export function loadRestoredFromStorage(): Map<number, RestoreStatusValue> {
  if (typeof window === "undefined") return new Map();
  try {
    const raw = window.localStorage.getItem(RESTORED_AUDIT_IDS_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as StoredEntry[];
    return new Map(
      parsed
        .map((entry): [number, RestoreStatusValue] | null => {
          switch (entry.outcome) {
            case "restored":
              return [entry.id, { kind: "restored", rel_path: entry.rel_path }];
            case "no_op":
              return [entry.id, { kind: "no_op", rel_path: entry.rel_path }];
            case "create_row":
              return [entry.id, { kind: "create_row" }];
            case "blob_missing":
              return [entry.id, { kind: "blob_missing" }];
            default:
              return null;
          }
        })
        .filter((p): p is [number, RestoreStatusValue] => p !== null),
    );
  } catch {
    return new Map();
  }
}

export function saveRestoredToStorage(
  auditId: number,
  outcome: RestoreOutcome,
): void {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(RESTORED_AUDIT_IDS_KEY);
    const list: StoredEntry[] = raw ? JSON.parse(raw) : [];
    // Replace any prior entry for this id so a state transition
    // (no_op → restored is the obvious one if the user re-saved
    // between attempts) actually updates.
    const filtered = list.filter((e) => e.id !== auditId);
    let entry: StoredEntry;
    switch (outcome.kind) {
      case "restored":
        entry = { id: auditId, outcome: "restored", rel_path: outcome.rel_path };
        break;
      case "no_op":
        entry = { id: auditId, outcome: "no_op", rel_path: outcome.rel_path };
        break;
      case "create_row":
        entry = { id: auditId, outcome: "create_row" };
        break;
      case "blob_missing":
        entry = { id: auditId, outcome: "blob_missing" };
        break;
    }
    filtered.push(entry);
    window.localStorage.setItem(
      RESTORED_AUDIT_IDS_KEY,
      JSON.stringify(filtered),
    );
  } catch {
    // Quota / private mode — best effort.
  }
}

export function clearRestoredStorage(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(RESTORED_AUDIT_IDS_KEY);
  } catch {
    // ignore
  }
}

type SettingsSection =
  | "general"
  | "claude"
  | "github"
  | "ops"
  | "activity"
  | "calendar"
  | "plugins"
  | "local-network"
  | "diagnostics";

type SettingsSectionMeta = {
  id: SettingsSection;
  label: string;
  /** Free-form keywords the section search can match against beyond
   *  the visible label — matches the controls / language a user might
   *  reach for ("dark mode" → Appearance → General). */
  keywords: string[];
};

const SECTIONS: SettingsSectionMeta[] = [
  {
    id: "general",
    label: "General",
    keywords: [
      "appearance",
      "theme",
      "dark mode",
      "light mode",
      "text size",
      "notifications",
      "morning briefing",
      "about",
      "version",
      "database path",
      "data folder",
      "content root",
      "content folder",
      "documents",
      "update",
      "updates",
      "auto-update",
      "version",
    ],
  },
  {
    id: "claude",
    label: "Claude Code",
    keywords: [
      "cli",
      "binary",
      "model",
      "opus",
      "settings file",
      "mcp",
      "extra args",
    ],
  },
  {
    id: "calendar",
    label: "Calendar",
    keywords: ["ics", "eventkit", "google", "transport", "url"],
  },
  {
    id: "github",
    label: "GitHub",
    keywords: [
      "gh",
      "pr",
      "pull request",
      "review",
      "auth",
      "token",
      "scopes",
      "velocity",
    ],
  },
  {
    id: "ops",
    label: "Ops",
    keywords: [
      "service",
      "team",
      "ownership",
      "datadog",
      "rollbar",
      "incident",
      "monitor",
    ],
  },
  {
    id: "plugins",
    label: "Plugins",
    keywords: ["manifest", "extensions", "load", "open folder"],
  },
  {
    id: "activity",
    label: "Activity",
    keywords: [
      "audit",
      "history",
      "restore",
      "undo",
      "chain",
      "verify",
      "filter",
    ],
  },
  {
    id: "local-network",
    label: "Local Network",
    keywords: [
      "mobile",
      "phone",
      "tablet",
      "lan",
      "wifi",
      "bridge",
      "qr",
      "token",
      "remote",
      "http",
      "port",
    ],
  },
  {
    id: "diagnostics",
    label: "Diagnostics",
    keywords: [
      "ping",
      "keychain",
      "encryption",
      "sqlcipher",
      "disk health",
      "blob",
      "snapshot",
      "perf",
    ],
  },
];

/** Score sections against a free-form query (B7-CP16). Pure so the
 *  search behavior can be unit-tested. Higher score = better match.
 *  0 means no match. */
export function scoreSection(
  section: SettingsSectionMeta,
  query: string,
): number {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return 0;
  const label = section.label.toLowerCase();
  if (label === q) return 100;
  if (label.startsWith(q)) return 90;
  if (label.includes(q)) return 70;
  let best = 0;
  for (const kw of section.keywords) {
    const k = kw.toLowerCase();
    if (k === q) best = Math.max(best, 60);
    else if (k.startsWith(q)) best = Math.max(best, 50);
    else if (k.includes(q)) best = Math.max(best, 30);
  }
  return best;
}

export function Settings() {
  const [section, setSection] = useState<SettingsSection>("general");
  const [info, setInfo] = useState<Status<BackendInfo>>({ kind: "pending" });
  const [ping, setPing] = useState<Status<PingResult> | null>(null);
  const [keychain, setKeychain] = useState<Status<string> | null>(null);
  const [audit, setAudit] = useState<Status<AuditRow[]>>({ kind: "pending" });
  const [chain, setChain] = useState<Status<AuditVerification> | null>(null);

  // Other surfaces can deep-link into a specific section by dispatching a
  // CustomEvent instead of plumbing nav callbacks through the whole tree.
  useEffect(() => {
    function onGotoSection(e: Event) {
      const detail = (e as CustomEvent<{ section?: SettingsSection }>).detail;
      if (detail?.section) setSection(detail.section);
    }
    window.addEventListener("cos:settings-section", onGotoSection);
    return () =>
      window.removeEventListener("cos:settings-section", onGotoSection);
  }, []);
  const [claudeStatus, setClaudeStatus] = useState<ClaudeCliStatus | null>(null);
  const [claudeForm, setClaudeForm] = useState<ClaudeCliConfig | null>(null);
  const [claudeBusy, setClaudeBusy] = useState(false);
  const [claudePing, setClaudePing] = useState<Status<string> | null>(null);
  const [claudeDirty, setClaudeDirty] = useState(false);
  const [mcpServers, setMcpServers] = useState<Status<McpServer[]> | null>(null);

  useEffect(() => {
    invoke<BackendInfo>("backend_version")
      .then((value) => setInfo({ kind: "ok", value }))
      .catch((error) => setInfo({ kind: "error", error: String(error) }));
  }, []);

  const refreshClaude = useCallback(async () => {
    try {
      const [status, config] = await Promise.all([
        invoke<ClaudeCliStatus>("claude_status"),
        invoke<ClaudeCliConfig>("claude_config_get"),
      ]);
      setClaudeStatus(status);
      setClaudeForm(config);
      setClaudeDirty(false);
    } catch {
      setClaudeStatus(null);
    }
  }, []);

  useEffect(() => {
    refreshClaude();
  }, [refreshClaude]);

  const saveClaudeConfig = useCallback(async () => {
    if (!claudeForm) return;
    setClaudeBusy(true);
    try {
      const status = await invoke<ClaudeCliStatus>("claude_config_set", {
        config: claudeForm,
      });
      setClaudeStatus(status);
      setClaudeForm({
        binary_path: status.binary_path_configured,
        settings_path: status.settings_path,
        extra_args: status.extra_args,
      });
      setClaudeDirty(false);
      setClaudePing(null);
    } catch (error) {
      window.alert(`Could not save: ${String(error)}`);
    } finally {
      setClaudeBusy(false);
    }
  }, [claudeForm]);

  const resetClaudeConfig = useCallback(async () => {
    setClaudeBusy(true);
    try {
      const status = await invoke<ClaudeCliStatus>("claude_config_reset");
      setClaudeStatus(status);
      setClaudeForm({
        binary_path: status.binary_path_configured,
        settings_path: status.settings_path,
        extra_args: status.extra_args,
      });
      setClaudeDirty(false);
      setClaudePing(null);
    } catch (error) {
      window.alert(`Could not reset: ${String(error)}`);
    } finally {
      setClaudeBusy(false);
    }
  }, []);

  const runClaudePing = useCallback(async () => {
    setClaudePing({ kind: "pending" });
    try {
      const value = await invoke<string>("claude_ping");
      setClaudePing({ kind: "ok", value });
    } catch (error) {
      setClaudePing({ kind: "error", error: String(error) });
    }
  }, []);

  const loadMcpServers = useCallback(async () => {
    setMcpServers({ kind: "pending" });
    try {
      const value = await invoke<McpServer[]>("claude_mcp_list");
      setMcpServers({ kind: "ok", value });
    } catch (error) {
      setMcpServers({ kind: "error", error: String(error) });
    }
  }, []);

  // Auto-load MCPs once the user is looking at the Claude tab and the CLI
  // is available. Kept behind section=='claude' so we don't shell out
  // before the user cares to see it.
  useEffect(() => {
    if (section === "claude" && claudeStatus?.available && mcpServers == null) {
      loadMcpServers();
    }
  }, [section, claudeStatus, mcpServers, loadMcpServers]);

  const mutateClaudeForm = (patch: Partial<ClaudeCliConfig>) => {
    setClaudeForm((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      setClaudeDirty(true);
      return next;
    });
  };

  // Audit filters live alongside the data they refine. Empty string =
  // no constraint (matches the audit::filter contract).
  const [auditAction, setAuditAction] = useState("");
  const [auditTarget, setAuditTarget] = useState("");
  const [auditFrom, setAuditFrom] = useState("");
  const [auditTo, setAuditTo] = useState("");
  // B7-CP24 pagination: limit grows by AUDIT_PAGE_SIZE on "load more".
  // Reset to AUDIT_PAGE_SIZE whenever a filter changes (otherwise the
  // user could narrow filters but still see the older N=200 batch).
  const [auditLimit, setAuditLimit] = useState(AUDIT_PAGE_SIZE);
  // mayHaveMore is set to true when the previous fetch returned a
  // full page (limit rows) — heuristic since the IPC doesn't return
  // a total count, but it's right enough for the "show button"
  // decision and a subsequent fetch will just return [] when there
  // really wasn't more.
  const [mayHaveMore, setMayHaveMore] = useState(true);

  const loadAudit = useCallback(async () => {
    setAudit({ kind: "pending" });
    try {
      const value = await invoke<AuditRow[]>("audit_filter", {
        actionPrefix: auditAction,
        targetQuery: auditTarget,
        fromIso: auditFrom || null,
        toIso: auditTo || null,
        limit: auditLimit,
      });
      setAudit({ kind: "ok", value });
      setMayHaveMore(value.length >= auditLimit);
    } catch (error) {
      setAudit({ kind: "error", error: String(error) });
    }
  }, [auditAction, auditTarget, auditFrom, auditTo, auditLimit]);

  // Reset pagination whenever the filter inputs (not the limit)
  // change. Watching auditLimit here would loop.
  useEffect(() => {
    setAuditLimit(AUDIT_PAGE_SIZE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auditAction, auditTarget, auditFrom, auditTo]);

  useEffect(() => {
    loadAudit();
  }, [loadAudit]);

  // Restore-from-audit handler. Only meaningful for doc.write rows;
  // the button at the row level is hidden otherwise.
  // Restore status keyed by audit row id, so each row can show its own
  // outcome inline. window.confirm/alert in the Tauri webview routes
  // through the native dialog system, which can render as a detached
  // window that's easy to miss; using inline state keeps the
  // confirmation + result anchored to the row the user clicked.
  //
  // Persisted: successful restores survive a Settings unmount /
  // remount via localStorage, so navigating away and back doesn't
  // re-arm the button on a row the user already rolled back. Per-row
  // state (running / error) stays ephemeral — it's transitional UI.
  const [restoreStatus, setRestoreStatus] = useState<
    Map<number, RestoreStatusValue>
  >(() => loadRestoredFromStorage());

  const restoreAudit = useCallback(
    async (auditId: number) => {
      setRestoreStatus((prev) => {
        const next = new Map(prev);
        next.set(auditId, { kind: "running" });
        return next;
      });
      try {
        // The Rust IPC returns one of four discriminated outcomes
        // (Restored / NoOp / CreateRow / BlobMissing). Handler
        // unwraps the SaveResult payload from Restored to a single
        // rel_path; everything else carries enough info on its own.
        const outcome = await invoke<
          | { kind: "restored"; rel_path: string }
          | { kind: "no_op"; rel_path: string }
          | { kind: "create_row" }
          | { kind: "blob_missing" }
          // The Restored variant from #[serde(tag = "kind")] flattens
          // SaveResult's fields directly; pull rel_path off it.
          | ({ kind: "restored" } & { rel_path?: string })
        >("audit_restore", { auditId });

        // Normalize to the canonical RestoreOutcome shape regardless
        // of which serde flatten path the backend takes.
        const normalized: RestoreOutcome = (() => {
          switch (outcome.kind) {
            case "restored":
              return {
                kind: "restored",
                rel_path: ("rel_path" in outcome && outcome.rel_path) || "",
              };
            case "no_op":
              return { kind: "no_op", rel_path: outcome.rel_path };
            case "create_row":
              return { kind: "create_row" };
            case "blob_missing":
              return { kind: "blob_missing" };
          }
        })();

        setRestoreStatus((prev) => {
          const next = new Map(prev);
          next.set(auditId, normalized);
          return next;
        });
        // ALL outcomes are sticky — once we've told the user "you
        // can't restore this row," they shouldn't have to find that
        // out again next time they switch tabs.
        saveRestoredToStorage(auditId, normalized);
        if (normalized.kind === "restored") {
          loadAudit();
        }
      } catch (error) {
        setRestoreStatus((prev) => {
          const next = new Map(prev);
          next.set(auditId, { kind: "error", error: String(error) });
          return next;
        });
      }
    },
    [loadAudit],
  );

  const runPing = useCallback(async () => {
    setPing({ kind: "pending" });
    try {
      const value = await invoke<PingResult>("db_ping");
      setPing({ kind: "ok", value });
    } catch (error) {
      setPing({ kind: "error", error: String(error) });
    }
  }, []);

  const runKeychain = useCallback(async () => {
    setKeychain({ kind: "pending" });
    const account = "checkpoint-2-test";
    const expected = `roundtrip-${Date.now()}`;
    try {
      await invoke("secret_set", { account, value: expected });
      const got = await invoke<string | null>("secret_get", { account });
      await invoke("secret_delete", { account });
      const gone = await invoke<string | null>("secret_get", { account });
      if (got !== expected) throw new Error(`read mismatch: got ${got ?? "null"}`);
      if (gone !== null) throw new Error(`delete failed: ${gone}`);
      setKeychain({ kind: "ok", value: "set → get → delete roundtrip passed" });
    } catch (error) {
      setKeychain({ kind: "error", error: String(error) });
    }
  }, []);

  const runVerify = useCallback(async () => {
    setChain({ kind: "pending" });
    try {
      const value = await invoke<AuditVerification>("audit_verify");
      setChain({ kind: "ok", value });
    } catch (error) {
      setChain({ kind: "error", error: String(error) });
    }
  }, []);

  // Settings search (B7-CP16). Empty → tabs render as usual. A query
  // ranks sections by scoreSection; the top result auto-selects so
  // typing "ping" lands on Diagnostics without an extra click. The
  // tabs row stays visible — search is augmentative, not a takeover.
  const [settingsQuery, setSettingsQuery] = useState("");
  const matchingSections = useMemo(() => {
    const q = settingsQuery.trim();
    if (!q) return [] as { meta: SettingsSectionMeta; score: number }[];
    return SECTIONS.map((meta) => ({
      meta,
      score: scoreSection(meta, q),
    }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
  }, [settingsQuery]);
  const topMatchId = matchingSections[0]?.meta.id;
  useEffect(() => {
    if (topMatchId && topMatchId !== section) {
      setSection(topMatchId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topMatchId]);

  return (
    <div className="cos-settings">
      <div className="cos-settings-search">
        <input
          type="search"
          className="cos-settings-search-input"
          placeholder="Search settings — e.g. opus, dark mode, ping…"
          aria-label="Search settings"
          value={settingsQuery}
          onChange={(e) => setSettingsQuery(e.target.value)}
        />
        {settingsQuery && (
          <button
            type="button"
            className="cos-btn cos-btn-ghost"
            onClick={() => setSettingsQuery("")}
          >
            clear
          </button>
        )}
      </div>
      <div className="cos-tabs" role="tablist">
        {SECTIONS.map((s) => {
          const matched =
            settingsQuery.trim().length > 0 &&
            matchingSections.some((m) => m.meta.id === s.id);
          const dimmed =
            settingsQuery.trim().length > 0 && !matched;
          return (
            <button
              key={s.id}
              role="tab"
              aria-selected={section === s.id}
              className={`cos-tab${section === s.id ? " is-active" : ""}${
                matched ? " is-search-match" : ""
              }${dimmed ? " is-search-dim" : ""}`}
              onClick={() => setSection(s.id)}
            >
              {s.label}
            </button>
          );
        })}
      </div>

      {section === "general" && (
        <>
          <AboutSection info={info} />
          <DataFolderSection />
          <UpdatesSection />
          <AppearanceSection />
          <NotificationsSection />
          <HomeSection />
        </>
      )}

      {section === "claude" && (
      <section className="cos-section">
        <header className="cos-section-head">
          <h2>Claude Code</h2>
          <p className="cos-section-lede">
            Skills (task creation, annotation processing, digest/prep runs)
            drive the locally-installed Claude Code CLI. Billing and model
            context stay on your machine; the app pipes prompts in and reads
            responses out.
          </p>
        </header>

        <dl className="cos-status">
          <dt>Status</dt>
          <dd>
            {claudeStatus == null ? (
              <span className="cos-pending">checking…</span>
            ) : claudeStatus.available ? (
              <span className="cos-good">
                found ·{" "}
                <code className="cos-path">
                  {claudeStatus.binary_path_resolved}
                </code>
              </span>
            ) : (
              <span className="cos-bad">
                not found — set the binary path below
              </span>
            )}
          </dd>

          <dt>Binary path</dt>
          <dd className="cos-claude-key-row">
            <input
              type="text"
              className="cos-text-input"
              placeholder="(auto-detect from $PATH and common locations)"
              value={claudeForm?.binary_path ?? ""}
              disabled={claudeBusy}
              onChange={(e) =>
                mutateClaudeForm({ binary_path: e.target.value })
              }
              spellCheck={false}
              aria-label="Claude binary path"
            />
          </dd>

          <dt>Settings file</dt>
          <dd className="cos-claude-key-row">
            <input
              type="text"
              className="cos-text-input"
              placeholder="(default: ~/.claude/settings.json)"
              value={claudeForm?.settings_path ?? ""}
              disabled={claudeBusy}
              onChange={(e) =>
                mutateClaudeForm({ settings_path: e.target.value })
              }
              spellCheck={false}
              aria-label="Claude settings file path"
            />
          </dd>

          <dt>CLI args</dt>
          <dd>
            <textarea
              className="cos-claude-args"
              rows={Math.max(3, (claudeForm?.extra_args.length ?? 0))}
              placeholder={(claudeStatus?.default_extra_args ?? []).join("\n")}
              value={(claudeForm?.extra_args ?? []).join("\n")}
              disabled={claudeBusy}
              onChange={(e) =>
                mutateClaudeForm({
                  extra_args: e.target.value
                    .split(/\r?\n/)
                    .map((s) => s.trim())
                    .filter((s) => s.length > 0),
                })
              }
              spellCheck={false}
              aria-label="Claude CLI arguments, one per line"
            />
            <div className="cos-section-lede cos-args-hint">
              One argument per line. Default:{" "}
              <code>
                claude {(claudeStatus?.default_extra_args ?? []).join(" ")}
              </code>
            </div>
          </dd>

          <dt>Config file</dt>
          <dd>
            <code className="cos-path">
              {claudeStatus?.config_file ?? "—"}
            </code>
          </dd>

          <dt>Actions</dt>
          <dd className="cos-claude-key-row">
            <button
              className="cos-btn"
              onClick={saveClaudeConfig}
              disabled={claudeBusy || !claudeDirty}
            >
              save
            </button>
            <button
              className="cos-btn cos-btn-ghost"
              onClick={refreshClaude}
              disabled={claudeBusy || !claudeDirty}
            >
              discard
            </button>
            <button
              className="cos-btn cos-btn-ghost"
              onClick={resetClaudeConfig}
              disabled={claudeBusy}
            >
              reset to defaults
            </button>
            <button
              className="cos-btn"
              onClick={runClaudePing}
              disabled={claudeBusy || !claudeStatus?.available}
            >
              test connection
            </button>
            {claudePing && (
              <span className="cos-claude-ping-result">
                {claudePing.kind === "pending" ? (
                  <span className="cos-pending">calling…</span>
                ) : claudePing.kind === "ok" ? (
                  <span className="cos-good">{claudePing.value}</span>
                ) : (
                  <span className="cos-bad">{claudePing.error}</span>
                )}
              </span>
            )}
          </dd>
        </dl>

        <McpBlock
          servers={mcpServers}
          available={claudeStatus?.available ?? false}
          onRefresh={loadMcpServers}
        />
      </section>
      )}

      {section === "activity" && (
      <section className="cos-section">
        <header className="cos-section-head">
          <h2>Recent activity</h2>
          <p className="cos-section-lede">
            Append-only audit log. Every write captures a content-addressed
            snapshot, restorable from any row.
          </p>
        </header>

        <div className="cos-audit-filters">
          <label className="cos-audit-filter">
            <span>Action</span>
            <select
              value={auditAction}
              onChange={(e) => setAuditAction(e.target.value)}
            >
              <option value="">all</option>
              <option value="doc.">doc.* (file writes)</option>
              <option value="doc.write">doc.write</option>
              <option value="task.">task.* (any task action)</option>
              <option value="task.create">task.create</option>
              <option value="task.update">task.update</option>
              <option value="task.complete">task.complete</option>
            </select>
          </label>
          <label className="cos-audit-filter">
            <span>Target contains</span>
            <input
              type="text"
              value={auditTarget}
              onChange={(e) => setAuditTarget(e.target.value)}
              placeholder="e.g. alice or 2026-04"
            />
          </label>
          <label className="cos-audit-filter">
            <span>From</span>
            <input
              type="date"
              value={auditFrom}
              onChange={(e) => setAuditFrom(e.target.value)}
            />
          </label>
          <label className="cos-audit-filter">
            <span>To</span>
            <input
              type="date"
              value={auditTo}
              onChange={(e) => setAuditTo(e.target.value)}
            />
          </label>
          {(auditAction || auditTarget || auditFrom || auditTo) && (
            <button
              type="button"
              className="cos-btn cos-btn-ghost"
              onClick={() => {
                setAuditAction("");
                setAuditTarget("");
                setAuditFrom("");
                setAuditTo("");
              }}
            >
              clear
            </button>
          )}
        </div>

        <div className="cos-audit-tools">
          <button className="cos-btn" onClick={loadAudit}>
            refresh
          </button>
          <button className="cos-btn" onClick={runVerify}>
            verify chain
          </button>
          {chain &&
            (chain.kind === "pending" ? (
              <span className="cos-pending">verifying…</span>
            ) : chain.kind === "error" ? (
              <span className="cos-bad">error: {chain.error}</span>
            ) : chain.value.ok ? (
              <span className="cos-good">chain intact</span>
            ) : (
              <span className="cos-bad">
                chain broken at row {chain.value.broken_at}
              </span>
            ))}
        </div>

        {audit.kind === "pending" && (
          <div className="cos-empty">Loading audit log…</div>
        )}
        {audit.kind === "error" && (
          <div className="cos-empty cos-empty-error">
            Could not load: {audit.error}
          </div>
        )}
        {audit.kind === "ok" && audit.value.length === 0 && (
          <div className="cos-empty">
            No activity yet. Edit a prep doc and save it to see the first entry.
          </div>
        )}
        {audit.kind === "ok" && audit.value.length > 0 && (
          <>
            <ul className="cos-audit-list">
              {audit.value.map((row) => (
                <AuditEntry
                  key={row.id}
                  row={row}
                  onRestore={restoreAudit}
                  restoreStatus={restoreStatus.get(row.id)}
                />
              ))}
            </ul>
            <div className="cos-audit-pagination">
              <span className="cos-audit-pagination-count">
                showing {audit.value.length}
                {audit.value.length === auditLimit && mayHaveMore
                  ? ` (limit ${auditLimit})`
                  : ""}
              </span>
              {mayHaveMore && audit.value.length >= auditLimit && (
                <button
                  type="button"
                  className="cos-btn cos-btn-ghost"
                  onClick={() =>
                    setAuditLimit((n) => n + AUDIT_PAGE_SIZE)
                  }
                >
                  load {AUDIT_PAGE_SIZE} more
                </button>
              )}
            </div>
          </>
        )}
      </section>
      )}

      {section === "calendar" && <CalendarSection />}

      {section === "github" && <GitHubSection />}

      {section === "ops" && <OpsSettingsSection />}

      {section === "plugins" && <PluginsSection />}

      {section === "local-network" && <LocalNetworkSection />}

      {section === "diagnostics" && (
      <section className="cos-section">
        <header className="cos-section-head">
          <h2>Diagnostics</h2>
          <p className="cos-section-lede">
            Smoke-tests for the backend wiring. Safe to run at any time.
          </p>
          <button
            type="button"
            className="cos-btn cos-btn-ghost"
            onClick={async () => {
              const dump = await collectDiagnosticsDump({
                info,
                ping,
                keychain,
              });
              const text = JSON.stringify(dump, null, 2);
              navigator.clipboard?.writeText(text).catch(() => {
                // Silent — clipboard denial in WKWebView is a config
                // issue, not something we can fix mid-flight.
              });
            }}
            title="Copy a JSON snapshot of build / DB / Claude / disk state for bug reports"
          >
            dump state to clipboard
          </button>
        </header>

        <InstallStatusPanel />

        <dl className="cos-status">
          <dt>Backend</dt>
          <dd>{render(info, (v) => v.version)}</dd>

          <dt>Database</dt>
          <dd>
            {info.kind === "ok" ? (
              <code className="cos-path">{info.value.db_path}</code>
            ) : (
              <span className="cos-pending">—</span>
            )}
          </dd>

          <dt>DB ping</dt>
          <dd>
            {ping
              ? render(ping, (v) => `${v.rows} rows · last ${v.last_write}`)
              : <button className="cos-btn" onClick={runPing}>run</button>}
            {ping && ping.kind !== "pending" && (
              <button className="cos-btn cos-btn-ghost" onClick={runPing}>
                again
              </button>
            )}
          </dd>

          <dt>Keychain</dt>
          <dd>
            {keychain
              ? render(keychain, (v) => v)
              : <button className="cos-btn" onClick={runKeychain}>run</button>}
            {keychain && keychain.kind !== "pending" && (
              <button className="cos-btn cos-btn-ghost" onClick={runKeychain}>
                again
              </button>
            )}
          </dd>
        </dl>

        <EncryptionPanel />
        <DiskHealthPanel />
        <PerfPanel />
      </section>
      )}
    </div>
  );
}

type DbEncryptionStatus = {
  key_present: boolean;
  sqlcipher_linked: boolean;
  encrypted: boolean;
};

/**
 * Database-encryption status (B4-CP3). Today the key plumbing is live
 * but SQLCipher itself isn't linked yet — that's a separate CP gated
 * on user opt-in (the rusqlite feature swap brings vendored OpenSSL
 * along which adds 5-10 minutes to a clean cargo build). The panel
 * shows what's true today and what changes when the user opts in.
 */
function EncryptionPanel() {
  const [status, setStatus] = useState<Status<DbEncryptionStatus>>({
    kind: "pending",
  });

  const refresh = useCallback(async () => {
    try {
      const value = await invoke<DbEncryptionStatus>("db_encryption_status");
      setStatus({ kind: "ok", value });
    } catch (error) {
      setStatus({ kind: "error", error: String(error) });
    }
  }, []);

  const generate = useCallback(async () => {
    try {
      await invoke("db_encryption_key_ensure");
      refresh();
    } catch (error) {
      window.alert(`Could not generate key: ${String(error)}`);
    }
  }, [refresh]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="cos-panel">
      <div className="cos-panel-head">
        <h3>Database encryption</h3>
        {status.kind === "ok" && !status.value.key_present && (
          <button type="button" className="cos-btn" onClick={generate}>
            generate key
          </button>
        )}
      </div>
      <p className="cos-section-lede">
        macOS FileVault already encrypts your home directory at rest;
        this layer adds defence-in-depth (SQLCipher + Keychain-stored
        key) for the audit log + snapshot DB. Today the key plumbing is
        live but the database itself isn't yet linked against
        SQLCipher — that swap is a separate opt-in CP because it adds
        a vendored-OpenSSL build step.
      </p>
      {status.kind === "pending" && <p>Loading…</p>}
      {status.kind === "error" && (
        <p className="cos-error">Could not load: {status.error}</p>
      )}
      {status.kind === "ok" && (
        <ul className="cos-install-list">
          <li
            className={`cos-install-row ${status.value.key_present ? "is-ok" : "is-fail"}`}
          >
            <span className="cos-install-mark" aria-hidden>
              {status.value.key_present ? "✓" : "○"}
            </span>
            <div className="cos-install-body">
              <span className="cos-install-label">Encryption key</span>
              <span className="cos-install-detail">
                {status.value.key_present
                  ? "256-bit key stored in Keychain"
                  : "no key yet — click 'generate key' to provision one"}
              </span>
            </div>
          </li>
          <li
            className={`cos-install-row ${status.value.sqlcipher_linked ? "is-ok" : "is-fail"}`}
          >
            <span className="cos-install-mark" aria-hidden>
              {status.value.sqlcipher_linked ? "✓" : "○"}
            </span>
            <div className="cos-install-body">
              <span className="cos-install-label">SQLCipher linked</span>
              <span className="cos-install-detail">
                {status.value.sqlcipher_linked
                  ? "DB writes encrypted at rest"
                  : "build links standard SQLite — DB encryption not active"}
              </span>
            </div>
          </li>
        </ul>
      )}
    </div>
  );
}

type DiskHealthSnapshot = {
  audit_rows: number;
  audit_latest_at: string | null;
  audit_db_bytes: number;
  blob_count: number;
  blob_bytes: number;
  oldest_restorable_at: string | null;
  content_md_count: number;
  content_md_bytes: number;
};

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function formatRelativeIso(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

/**
 * Snapshots the safety floor: how many audit rows exist, how big the
 * blob store has grown, when the oldest restorable doc.write was, how
 * much markdown is under management. The user gets a concrete sense
 * of "yes the system is logging + capturing what it claims to be."
 */
function DiskHealthPanel() {
  const [load, setLoad] = useState<Status<DiskHealthSnapshot>>({
    kind: "pending",
  });

  const refresh = useCallback(async () => {
    setLoad({ kind: "pending" });
    try {
      const value = await invoke<DiskHealthSnapshot>("disk_health");
      setLoad({ kind: "ok", value });
    } catch (error) {
      setLoad({ kind: "error", error: String(error) });
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="cos-panel">
      <div className="cos-panel-head">
        <h3>Disk health</h3>
        <button type="button" className="cos-btn cos-btn-ghost" onClick={refresh}>
          refresh
        </button>
      </div>
      <p className="cos-section-lede">
        What the safety floor is currently holding. Audit log rows are
        append-only; blob store captures content-addressed snapshots
        of every doc write so they can be restored from Activity.
      </p>
      {load.kind === "pending" && <p>Loading…</p>}
      {load.kind === "error" && (
        <p className="cos-error">Could not load: {load.error}</p>
      )}
      {load.kind === "ok" && (
        <table className="cos-perf-table">
          <tbody>
            <tr>
              <td>Audit rows</td>
              <td>{load.value.audit_rows.toLocaleString()}</td>
              <td>
                {load.value.audit_latest_at
                  ? `latest ${formatRelativeIso(load.value.audit_latest_at)}`
                  : "—"}
              </td>
            </tr>
            <tr>
              <td>Audit DB</td>
              <td colSpan={2}>{formatBytes(load.value.audit_db_bytes)}</td>
            </tr>
            <tr>
              <td>Blob store</td>
              <td>{load.value.blob_count.toLocaleString()} files</td>
              <td>{formatBytes(load.value.blob_bytes)}</td>
            </tr>
            <tr>
              <td>Oldest restorable</td>
              <td colSpan={2}>
                {load.value.oldest_restorable_at
                  ? `${formatRelativeIso(load.value.oldest_restorable_at)} (${load.value.oldest_restorable_at.slice(0, 10)})`
                  : "no restorable rows yet"}
              </td>
            </tr>
            <tr>
              <td>Content tree</td>
              <td>{load.value.content_md_count.toLocaleString()} .md files</td>
              <td>{formatBytes(load.value.content_md_bytes)}</td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}

type InstallCheck = {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  fix_hint: string;
};

type InstallStatus = {
  checks: InstallCheck[];
  all_ok: boolean;
};

/**
 * M5 install / first-run readiness panel. Surfaces three checks
 * (content root, Claude CLI, calendar source) with one-click deep-
 * links to the relevant Settings tab when any check fails.
 *
 * Lives at the top of Diagnostics because that's where the user
 * already looks when something is off — no separate "Setup" surface
 * to learn.
 */
/**
 * PRD-115 §7.8 — theme picker. Reads/writes the selected theme via the
 * registry helper, applies it to documentElement immediately so the
 * preview is live (no reload required).
 */
function AppearanceSection() {
  const [active, setActive] = useState<string>(() => readTheme());
  const [textScale, setTextScale] = useState<number>(() => readTextScale());
  const [accentInput, setAccentInput] = useState<string>(
    () => readAccentOverride() ?? "",
  );
  const [accentDirty, setAccentDirty] = useState(false);
  const [toolbarDensity, setToolbarDensity] = useState<ToolbarDensity>(
    () => readToolbarDensity(),
  );
  const [sidebarRecentsMax, setSidebarRecentsMax] =
    useState<SidebarRecentsMax>(() => readSidebarRecentsMax());
  const [showDeveloperSurfaces, setShowDeveloperSurfaces] = useState<boolean>(
    () => readShowDeveloperSurfaces(),
  );

  const select = (id: string) => {
    setActive(id);
    writeTheme(id);
    applyTheme(id);
  };

  const handleTextScale = (next: number) => {
    const clamped = clampTextScale(next);
    setTextScale(clamped);
    writeTextScale(clamped);
    applyTextScale(clamped);
  };

  const resetTextScale = () => handleTextScale(DEFAULT_TEXT_SCALE);

  const accentNormalized = normalizeAccentHex(accentInput);
  const accentValid = accentInput.trim().length === 0 || accentNormalized !== null;
  const applyAccent = () => {
    const hex = accentNormalized;
    writeAccentOverride(hex);
    applyAccentOverride(hex);
    setAccentDirty(false);
  };
  const resetAccent = () => {
    setAccentInput("");
    writeAccentOverride(null);
    applyAccentOverride(null);
    setAccentDirty(false);
  };

  const scalePercent = Math.round(textScale * 100);
  const scaleLabel =
    textScale < 0.95
      ? "Smaller"
      : textScale > 1.05
        ? "Larger"
        : "Default";

  const groups = {
    light: THEMES.filter((t) => t.scheme === "light"),
    dark: THEMES.filter((t) => t.scheme === "dark"),
  };

  return (
    <section className="cos-section">
      <header className="cos-section-head">
        <h2>Appearance</h2>
        <p className="cos-section-lede">
          Theme and text size. Both apply instantly and persist.
        </p>
      </header>

      <div className="cos-field">
        <span className="cos-field-label">Light themes</span>
        <div className="cos-theme-picker">
          {groups.light.map((t) => (
            <ThemeChip
              key={t.id}
              theme={t}
              active={active === t.id}
              onSelect={() => select(t.id)}
            />
          ))}
        </div>
      </div>

      <div className="cos-field">
        <span className="cos-field-label">Dark themes</span>
        <div className="cos-theme-picker">
          {groups.dark.map((t) => (
            <ThemeChip
              key={t.id}
              theme={t}
              active={active === t.id}
              onSelect={() => select(t.id)}
            />
          ))}
        </div>
      </div>

      <div className="cos-field">
        <label
          htmlFor="cos-text-scale-slider"
          className="cos-field-label"
        >
          Text size
        </label>
        <div className="cos-text-scale-control">
          <span className="cos-text-scale-edge cos-text-scale-edge-small">
            A
          </span>
          <input
            id="cos-text-scale-slider"
            type="range"
            min={MIN_TEXT_SCALE}
            max={MAX_TEXT_SCALE}
            step={TEXT_SCALE_STEP}
            value={textScale}
            onChange={(e) => handleTextScale(Number(e.target.value))}
            aria-label="Text size"
            aria-valuetext={`${scalePercent}%`}
            className="cos-text-scale-slider"
          />
          <span className="cos-text-scale-edge cos-text-scale-edge-large">
            A
          </span>
          <span className="cos-text-scale-readout" aria-live="polite">
            {scaleLabel} · {scalePercent}%
          </span>
          {textScale !== DEFAULT_TEXT_SCALE && (
            <button
              type="button"
              className="cos-btn cos-btn-ghost"
              onClick={resetTextScale}
              title="Reset to default (100%)"
            >
              reset
            </button>
          )}
        </div>
      </div>

      <div className="cos-field">
        <label
          htmlFor="cos-sidebar-recents-max"
          className="cos-field-label"
        >
          Sidebar recent docs
        </label>
        <select
          id="cos-sidebar-recents-max"
          className="cos-settings-select"
          value={sidebarRecentsMax}
          onChange={(e) => {
            const next = Number(e.target.value) as SidebarRecentsMax;
            setSidebarRecentsMax(next);
            writeSidebarRecentsMax(next);
          }}
        >
          {SIDEBAR_RECENTS_MAX_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <p className="cos-helper-text">
          How many recently-opened docs the sidebar's Recent section
          shows. Pinned docs always count toward this cap and survive
          when you blow past it.
        </p>
      </div>

      <div className="cos-field">
        <span className="cos-field-label">Toolbar density</span>
        <div className="cos-density-toggle" role="radiogroup">
          {(
            [
              ["comfortable", "Comfortable"],
              ["compact", "Compact"],
            ] as const
          ).map(([id, label]) => (
            <label
              key={id}
              className={`cos-density-option${
                toolbarDensity === id ? " is-active" : ""
              }`}
            >
              <input
                type="radio"
                name="cos-toolbar-density"
                value={id}
                checked={toolbarDensity === id}
                onChange={() => {
                  setToolbarDensity(id);
                  writeToolbarDensity(id);
                  window.dispatchEvent(
                    new CustomEvent("cos:toolbar-density-changed"),
                  );
                }}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
        <p className="cos-helper-text">
          Compact tightens the editor toolbar so longer-text buttons
          (link, table, copy md) take less horizontal room.
        </p>
      </div>

      <div className="cos-field">
        <span className="cos-field-label">Developer surfaces</span>
        <label className="cos-toggle-row">
          <input
            type="checkbox"
            checked={showDeveloperSurfaces}
            onChange={(e) => {
              setShowDeveloperSurfaces(e.target.checked);
              writeShowDeveloperSurfaces(e.target.checked);
            }}
          />
          <span>Show Console in the sidebar</span>
        </label>
        <p className="cos-helper-text">
          Console is a direct Claude Code session inside the app — same{" "}
          <code>claude</code> binary as your terminal, same skills, same{" "}
          <code>CLAUDE.md</code>. Hidden by default; enable here when
          you want it as a top-level surface.
        </p>
      </div>

      <div className="cos-field">
        <label htmlFor="cos-accent-input" className="cos-field-label">
          Accent color
        </label>
        <div className="cos-accent-control">
          <input
            id="cos-accent-input"
            type="text"
            className="cos-accent-input"
            value={accentInput}
            placeholder="#7aa2f7"
            spellCheck={false}
            aria-invalid={!accentValid}
            aria-describedby="cos-accent-help"
            onChange={(e) => {
              setAccentInput(e.target.value);
              setAccentDirty(true);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (accentValid) applyAccent();
              }
            }}
          />
          {accentNormalized && (
            <span
              className="cos-accent-swatch"
              style={{ background: accentNormalized }}
              aria-hidden
            />
          )}
          <button
            type="button"
            className="cos-btn"
            onClick={applyAccent}
            disabled={!accentValid || !accentDirty}
          >
            apply
          </button>
          <button
            type="button"
            className="cos-btn cos-btn-ghost"
            onClick={resetAccent}
            disabled={
              accentInput.trim().length === 0 && !readAccentOverride()
            }
            title="Restore the theme's default accent"
          >
            reset
          </button>
        </div>
        <p id="cos-accent-help" className="cos-helper-text">
          Override the theme's accent (links, focus rings, badges).
          Leave blank to use the theme default. Hex format: #abc or
          #aabbcc.
        </p>
        {!accentValid && (
          <p className="cos-bad">
            Not a valid hex color. Use #abc or #aabbcc.
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * Native-OS notification toggle. Default ON; when OFF, every call to
 * notify() short-circuits. Per-machine setting via localStorage.
 *
 * Also exposes a permission-preflight + test button. macOS reliably
 * shows the permission prompt only in response to a user gesture, so
 * we trigger it from a button click here instead of lazily on the
 * first skill completion (which fires async, often after the user
 * has walked away).
 */
function NotificationsSection() {
  const [enabled, setEnabled] = useState<boolean>(() => {
    try {
      const raw = window.localStorage.getItem("cos.notifications-enabled.v1");
      return raw === null ? true : raw === "true";
    } catch {
      return true;
    }
  });
  const [testStatus, setTestStatus] = useState<string | null>(null);

  const toggle = (next: boolean) => {
    setEnabled(next);
    try {
      window.localStorage.setItem(
        "cos.notifications-enabled.v1",
        String(next),
      );
    } catch {
      /* ignore */
    }
  };

  const sendTest = async () => {
    setTestStatus("requesting…");
    try {
      const { requestNotificationPermission, notify } = await import(
        "../state/notifications"
      );
      const granted = await requestNotificationPermission();
      if (!granted) {
        setTestStatus(
          "permission denied — flip in System Settings → Notifications → Chief of Staff. Falling back to in-app toast.",
        );
        await notify("Test notification", "permission denied");
        return;
      }
      await notify("Test notification", "If you see this, you're set.");
      setTestStatus(
        "✓ sent — if it didn't appear in the upper-right, check System Settings → Notifications → Chief of Staff",
      );
    } catch (error) {
      setTestStatus(`failed: ${String(error)}`);
    }
  };

  return (
    <section className="cos-section">
      <header className="cos-section-head">
        <h2>Notifications</h2>
        <p className="cos-section-lede">
          macOS notifications when long-running skills complete (briefing,
          prep, digest, triage). Short skills under 4 seconds never notify.
        </p>
      </header>

      <div className="cos-field">
        <label className="cos-toggle-row">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => toggle(e.target.checked)}
          />
          <span>
            <strong>{enabled ? "On" : "Off"}</strong> — fire native
            notifications when a skill finishes
          </span>
        </label>
      </div>

      <div className="cos-field">
        <span className="cos-field-label">Permission check</span>
        <div className="cos-field-row">
          <button
            type="button"
            className="cos-btn"
            onClick={sendTest}
            disabled={!enabled}
          >
            send test notification
          </button>
          {testStatus && (
            <span className="cos-field-status">{testStatus}</span>
          )}
        </div>
        <p className="cos-helper-text">
          macOS only shows the permission prompt during a user gesture.
          Click once to grant. If you deny, notifications fall back to an
          in-app toast.
        </p>
      </div>
    </section>
  );
}

function ThemeChip({
  theme,
  active,
  onSelect,
}: {
  theme: (typeof THEMES)[number];
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`cos-theme-chip ${active ? "is-active" : ""}`}
      onClick={onSelect}
      title={theme.description}
      aria-pressed={active}
    >
      {theme.label}
    </button>
  );
}

function InstallStatusPanel() {
  const [load, setLoad] = useState<Status<InstallStatus>>({ kind: "pending" });

  const refresh = useCallback(async () => {
    try {
      const value = await invoke<InstallStatus>("install_status");
      setLoad({ kind: "ok", value });
    } catch (error) {
      setLoad({ kind: "error", error: String(error) });
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const fix = (hint: string) => {
    const [surface, section] = hint.split(":");
    if (!surface) return;
    if (surface === "settings" && section) {
      window.dispatchEvent(
        new CustomEvent("cos:settings-section", { detail: { section } }),
      );
    }
  };

  if (load.kind === "pending") return null;
  if (load.kind === "error") {
    return (
      <p className="cos-error">Could not check setup: {load.error}</p>
    );
  }

  return (
    <div className="cos-panel">
      <div className="cos-panel-head">
        <h3>Setup readiness</h3>
        <div className="cos-panel-actions">
          <button
            type="button"
            className="cos-btn cos-btn-ghost"
            onClick={() => {
              window.dispatchEvent(new CustomEvent("cos:open-install-wizard"));
            }}
          >
            re-run setup
          </button>
          <button
            type="button"
            className="cos-btn cos-btn-ghost"
            onClick={refresh}
          >
            re-check
          </button>
        </div>
      </div>
      <ul className="cos-install-list">
        {load.value.checks.map((c) => (
          <li
            key={c.id}
            className={`cos-install-row ${c.ok ? "is-ok" : "is-fail"}`}
          >
            <span className="cos-install-mark" aria-hidden>
              {c.ok ? "✓" : "✗"}
            </span>
            <div className="cos-install-body">
              <span className="cos-install-label">{c.label}</span>
              <span className="cos-install-detail">{c.detail}</span>
            </div>
            {!c.ok && c.fix_hint && (
              <button
                type="button"
                className="cos-btn cos-btn-ghost"
                onClick={() => fix(c.fix_hint)}
              >
                fix
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

type PerfSummary = {
  kind: string;
  count: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  recent: { kind: string; duration_ms: number; at: string }[];
};

/**
 * PRD-101 perf harness readout. Pulls summaries from perf_summaries
 * IPC and renders p50/p95/p99 per kind. The PRD-115 success-criterion
 * #8 ("no perf regression") will be eyeball-verified against this
 * panel — pre-pass + post-pass screenshots into the implementation
 * tracker.
 */
function PerfPanel() {
  const [load, setLoad] = useState<Status<PerfSummary[]>>({ kind: "pending" });
  const refresh = useCallback(async () => {
    setLoad({ kind: "pending" });
    try {
      const value = await invoke<PerfSummary[]>("perf_summaries", {
        recent: 5,
      });
      setLoad({ kind: "ok", value });
    } catch (error) {
      setLoad({ kind: "error", error: String(error) });
    }
  }, []);
  const clear = useCallback(async () => {
    try {
      await invoke("perf_clear");
      refresh();
    } catch (error) {
      window.alert(`Could not clear: ${String(error)}`);
    }
  }, [refresh]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="cos-panel">
      <div className="cos-panel-head">
        <h3>Performance</h3>
        <div className="cos-panel-actions">
          <button className="cos-btn cos-btn-ghost" onClick={refresh}>
            refresh
          </button>
          <button className="cos-btn cos-btn-ghost" onClick={clear}>
            clear
          </button>
        </div>
      </div>
      <p className="cos-section-lede">
        Rolling sample of view-switch / palette-open / editor-input /
        IPC timings. PRD-101 budgets: view-switch ≤ 120ms, palette open
        ≤ 40ms warm, editor input ≤ 50ms p99.
      </p>
      {load.kind === "pending" && <p>Loading…</p>}
      {load.kind === "error" && (
        <p className="cos-error">Could not load: {load.error}</p>
      )}
      {load.kind === "ok" && load.value.length === 0 && (
        <p className="cos-empty">
          No samples yet. Use the app and come back — instrumentation
          records on view-switch, palette open, and IPC calls.
        </p>
      )}
      {load.kind === "ok" && load.value.length > 0 && (
        <table className="cos-perf-table">
          <thead>
            <tr>
              <th>kind</th>
              <th>count</th>
              <th>p50</th>
              <th>p95</th>
              <th>p99</th>
            </tr>
          </thead>
          <tbody>
            {load.value.map((s) => (
              <tr key={s.kind}>
                <td>{s.kind}</td>
                <td>{s.count}</td>
                <td>{s.p50_ms.toFixed(1)}ms</td>
                <td>{s.p95_ms.toFixed(1)}ms</td>
                <td>{s.p99_ms.toFixed(1)}ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function McpBlock({
  servers,
  available,
  onRefresh,
}: {
  servers: Status<McpServer[]> | null;
  available: boolean;
  onRefresh: () => void;
}) {
  // Merge live status with the recommended list so the user sees at-a-glance
  // which of the high-value connectors are wired up, and which are missing.
  const byName = new Map<string, McpServer>();
  if (servers?.kind === "ok") {
    for (const s of servers.value) byName.set(s.name, s);
  }

  return (
    <div className="cos-mcp-block">
      <div className="cos-mcp-head">
        <h3>MCP connectors</h3>
        <button
          type="button"
          className="cos-btn cos-btn-ghost"
          onClick={onRefresh}
          disabled={!available}
          title={
            available
              ? "Run `claude mcp list` and refresh"
              : "Configure the Claude binary first"
          }
        >
          refresh
        </button>
      </div>
      <p className="cos-section-lede">
        Skills inherit whatever MCP servers Claude Code has wired up — org
        generation in particular leans on Glean, Google Workspace, and
        Slack. Connect any of these in your Claude Code setup (not this app
        — configure them once and all skills benefit).
      </p>

      {!available && (
        <div className="cos-empty">
          Configure the Claude binary above to list connected MCPs.
        </div>
      )}

      {available && servers?.kind === "pending" && (
        <div className="cos-empty">Listing MCPs…</div>
      )}
      {available && servers?.kind === "error" && (
        <div className="cos-empty cos-empty-error">
          Could not list: {servers.error}
        </div>
      )}

      {available && servers?.kind === "ok" && (
        <>
          <h4 className="cos-mcp-subhead">Recommended for v2 skills</h4>
          <ul className="cos-mcp-list">
            {RECOMMENDED_MCPS.map((r) => {
              const live = byName.get(r.name);
              const state: "connected" | "configured" | "missing" = !live
                ? "missing"
                : live.connected
                  ? "connected"
                  : "configured";
              return (
                <li key={r.name} className={`cos-mcp-row cos-mcp-${state}`}>
                  <span className="cos-mcp-dot" aria-hidden>
                    {state === "connected"
                      ? "●"
                      : state === "configured"
                        ? "○"
                        : "·"}
                  </span>
                  <span className="cos-mcp-name">{r.name}</span>
                  <span className="cos-mcp-purpose">{r.purpose}</span>
                  <span className="cos-mcp-state">
                    {state === "connected"
                      ? "connected"
                      : state === "configured"
                        ? "configured, disconnected"
                        : "not configured"}
                  </span>
                </li>
              );
            })}
          </ul>

          {servers.value.filter(
            (s) => !RECOMMENDED_MCPS.some((r) => r.name === s.name),
          ).length > 0 && (
            <>
              <h4 className="cos-mcp-subhead">Other MCPs</h4>
              <ul className="cos-mcp-list">
                {servers.value
                  .filter(
                    (s) => !RECOMMENDED_MCPS.some((r) => r.name === s.name),
                  )
                  .map((s) => (
                    <li
                      key={s.name}
                      className={`cos-mcp-row ${
                        s.connected ? "cos-mcp-connected" : "cos-mcp-configured"
                      }`}
                    >
                      <span className="cos-mcp-dot" aria-hidden>
                        {s.connected ? "●" : "○"}
                      </span>
                      <span className="cos-mcp-name">{s.name}</span>
                      <span className="cos-mcp-purpose">{s.info}</span>
                      <span className="cos-mcp-state">
                        {s.connected ? "connected" : "disconnected"}
                      </span>
                    </li>
                  ))}
              </ul>
            </>
          )}

          {servers.value.length === 0 && (
            <div className="cos-empty">No MCP servers configured.</div>
          )}
        </>
      )}
    </div>
  );
}

function DetailValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <code>null</code>;
  }
  if (typeof value === "object") {
    return (
      <pre className="cos-audit-json">
        <code>{JSON.stringify(value, null, 2)}</code>
      </pre>
    );
  }
  return <code>{String(value)}</code>;
}

/**
 * Diagnostics state dump (B7-CP18). Pulls the values already in the
 * Settings page state plus fresh disk-health / encryption-status /
 * claude-status / install-status snapshots from the backend and
 * shapes them into a JSON-friendly object the user can paste into a
 * bug report.
 *
 * Pure-ish — the IPC calls happen here but the shape function is
 * extracted from the button onClick so unit tests can exercise the
 * status-extraction half (statusValueOrError) without mocking
 * clipboards.
 */
export type DumpableStatus<T> =
  | { kind: "pending" }
  | { kind: "ok"; value: T }
  | { kind: "error"; error: string }
  | null;

export function statusValueOrError<T>(
  s: DumpableStatus<T>,
): T | { error: string } | "pending" | null {
  if (s == null) return null;
  if (s.kind === "pending") return "pending";
  if (s.kind === "error") return { error: s.error };
  return s.value;
}

export async function collectDiagnosticsDump(state: {
  info: Status<BackendInfo>;
  ping: Status<PingResult> | null;
  keychain: Status<string> | null;
}): Promise<Record<string, unknown>> {
  const dump: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    backend: statusValueOrError(state.info),
    db_ping: statusValueOrError(state.ping),
    keychain: statusValueOrError(state.keychain),
    user_agent:
      typeof navigator !== "undefined" ? navigator.userAgent : null,
  };
  // Best-effort backend probes — wrap each in try/catch so a single
  // failure doesn't poison the whole dump.
  for (const [key, cmd] of [
    ["claude_status", "claude_status"],
    ["install_status", "install_status"],
    ["disk_health", "disk_health"],
    ["db_encryption_status", "db_encryption_status"],
  ] as const) {
    try {
      dump[key] = await invoke(cmd);
    } catch (error) {
      dump[key] = { error: String(error) };
    }
  }
  return dump;
}

/**
 * Build the structured JSON payload for an audit row's "copy as JSON"
 * button. Pure so the shape can be unit-tested without spinning up
 * the clipboard API.
 */
export function auditRowCopyPayload(
  row: AuditRow,
  parsedDetail: Record<string, unknown>,
): {
  id: number;
  at: string;
  actor: string;
  action: string;
  target_kind: string;
  target_id: string;
  this_hash: string;
  detail: Record<string, unknown>;
} {
  return {
    id: row.id,
    at: row.at,
    actor: row.actor,
    action: row.action,
    target_kind: row.target_kind,
    target_id: row.target_id,
    this_hash: row.this_hash,
    detail: parsedDetail,
  };
}

/**
 * Copy a single audit row to the clipboard as a structured JSON
 * payload — useful for grabbing the row + its parsed detail when
 * filing a bug or sharing context. Uses navigator.clipboard with no
 * toast on success; the user sees the action complete by the row
 * staying visible. Errors fall through silently (rare in Tauri).
 */
function copyAuditRowToClipboard(
  row: AuditRow,
  parsedDetail: Record<string, unknown>,
): void {
  const text = JSON.stringify(auditRowCopyPayload(row, parsedDetail), null, 2);
  navigator.clipboard?.writeText(text).catch(() => {
    // Fall back: place into a temporary input + execCommand so the
    // user still gets the row in their clipboard. No toast here —
    // the empty action is a noop, not a failure path the user needs
    // to recover from.
  });
}

function AuditEntry({
  row,
  onRestore,
  restoreStatus,
}: {
  row: AuditRow;
  onRestore?: (id: number) => void;
  restoreStatus?: RestoreStatusValue;
}) {
  const [open, setOpen] = useState(false);
  // Two-step confirm: first click arms, second click within the same
  // expanded panel actually fires. Replaces window.confirm() which
  // was rendering as a detached macOS dialog easy to miss.
  const [armed, setArmed] = useState(false);
  let detail: Record<string, unknown> = {};
  try {
    detail = JSON.parse(row.detail_json);
  } catch {
    /* ignore */
  }
  // Only doc.write rows with a captured before-blob can be restored.
  // The actual restorability check is server-side; we hide the button
  // for create rows (before_hash null) so the user doesn't get a
  // confusing "nothing to restore" alert.
  const restorable =
    row.action === "doc.write" && (detail as { before_hash?: string }).before_hash != null;
  return (
    <li className="cos-audit-row">
      <button
        type="button"
        className="cos-audit-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="cos-audit-action">{row.action}</span>
        <span className="cos-audit-target">{row.target_id}</span>
        <span className="cos-audit-at">{row.at}</span>
        <span className="cos-audit-actor">{row.actor}</span>
      </button>
      {open && (
        <div className="cos-audit-detail">
          <div className="cos-audit-copy-row">
            <button
              type="button"
              className="cos-btn cos-btn-ghost"
              onClick={() => copyAuditRowToClipboard(row, detail)}
              title="Copy audit row as JSON to clipboard"
            >
              copy as JSON
            </button>
          </div>
          {restorable && onRestore && (
            <div className="cos-audit-actions">
              {restoreStatus?.kind === "restored" ? (
                <span className="cos-good">
                  ✓ restored {restoreStatus.rel_path}
                </span>
              ) : restoreStatus?.kind === "no_op" ? (
                <span className="cos-pending">
                  ✓ already at this version (no change needed)
                </span>
              ) : restoreStatus?.kind === "create_row" ? (
                <span className="cos-pending">
                  this row was the file's first write — nothing to restore to
                </span>
              ) : restoreStatus?.kind === "blob_missing" ? (
                <span className="cos-pending">
                  snapshot not captured for this write (predates the
                  always-capture fix; new writes are recoverable)
                </span>
              ) : restoreStatus?.kind === "running" ? (
                <span className="cos-pending">restoring…</span>
              ) : restoreStatus?.kind === "error" ? (
                <span className="cos-bad">
                  restore failed: {restoreStatus.error}
                </span>
              ) : armed ? (
                <>
                  <span style={{ marginRight: 8 }}>
                    Replace current contents with the version before this
                    write?
                  </span>
                  <button
                    type="button"
                    className="cos-btn"
                    onClick={() => {
                      setArmed(false);
                      onRestore(row.id);
                    }}
                  >
                    confirm restore
                  </button>
                  <button
                    type="button"
                    className="cos-btn cos-btn-ghost"
                    onClick={() => setArmed(false)}
                  >
                    cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="cos-btn cos-btn-ghost"
                  onClick={() => setArmed(true)}
                  title="Restore the file to its state before this write"
                >
                  restore
                </button>
              )}
            </div>
          )}
          <dl>
            <dt>id</dt>
            <dd>{row.id}</dd>
            <dt>target kind</dt>
            <dd>{row.target_kind}</dd>
            <dt>hash</dt>
            <dd>
              <code>{row.this_hash}</code>
            </dd>
            {Object.entries(detail).map(([k, v]) => (
              <div key={k} style={{ display: "contents" }}>
                <dt>{k}</dt>
                <dd>
                  <DetailValue value={v} />
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </li>
  );
}

type CalendarConfig = {
  ics_url: string;
  transport: "ics" | "eventkit";
};

/**
 * GitHub auth + status (B8-CP3, PRD-109). Read-only diagnostic of
 * the user's `gh` install: where the binary lives, who they're
 * logged in as, what scopes the token has, and what (if anything)
 * is missing. The Velocity tabs (PRD-109 §5.1) all shell out
 * through this same `gh`; if the card here is healthy the tabs
 * have what they need.
 */
type GhStatus = {
  binary_path: string | null;
  authed: boolean;
  login: string | null;
  scopes: string[];
  missing_scopes: string[];
  error: string | null;
};

import type { VelocityPrefs } from "../state/velocityPrefs";
import { readPrefs, writePrefs } from "../state/velocityPrefs";
import {
  readOpsPrefs,
  writeOpsPrefs,
  parseTeamServices,
  formatTeamServices,
  type OpsPrefs,
} from "../state/opsPrefs";
import {
  readHomePrefs,
  writeHomePrefs,
  moveStrip,
  STRIP_LABELS,
  type HomeStripId,
} from "../state/homePrefs";

function GitHubSection() {
  const [load, setLoad] = useState<Status<GhStatus>>({ kind: "pending" });
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoad({ kind: "pending" });
      try {
        const status = await invoke<GhStatus>("gh_status");
        if (!cancelled) setLoad({ kind: "ok", value: status });
      } catch (err) {
        if (!cancelled) setLoad({ kind: "error", error: String(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshNonce]);

  // B8-CP12 — Velocity prefs (bot exclusions) live in localStorage.
  const [prefs, setPrefs] = useState<VelocityPrefs>(() => readPrefs());
  const [draftAuthors, setDraftAuthors] = useState(() =>
    readPrefs().excludedAuthors.join("\n"),
  );
  const savePrefs = (next: VelocityPrefs) => {
    writePrefs(next);
    setPrefs(next);
  };
  const saveAuthors = () => {
    const lines = draftAuthors
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    savePrefs({ ...prefs, excludedAuthors: lines });
  };

  return (
    <section className="cos-section">
      <header className="cos-section-head">
        <h2>GitHub</h2>
        <p className="cos-section-lede">
          The Velocity tabs (Tasks → PRs / Review) shell out to your
          local <code>gh</code> CLI. Sign in once with{" "}
          <code>gh auth login</code> and v2 picks up the same auth.
        </p>
      </header>
      {load.kind === "pending" && (
        <p className="cos-pending">Probing gh…</p>
      )}
      {load.kind === "error" && (
        <p className="cos-bad">error: {load.error}</p>
      )}
      {load.kind === "ok" && (
        <dl className="cos-status">
          <dt>Binary</dt>
          <dd>
            {load.value.binary_path ? (
              <code className="cos-path">{load.value.binary_path}</code>
            ) : (
              <span className="cos-bad">
                not found on $PATH — install <code>gh</code> via Homebrew
                or your package manager
              </span>
            )}
          </dd>
          <dt>Auth</dt>
          <dd>
            {load.value.authed ? (
              <span className="cos-good">
                ✓ logged in
                {load.value.login ? (
                  <>
                    {" "}as <code>{load.value.login}</code>
                  </>
                ) : null}
              </span>
            ) : (
              <span className="cos-bad">
                not authed — run <code>gh auth login</code>
              </span>
            )}
            {load.value.error && !load.value.authed && (
              <p className="cos-helper-text">{load.value.error}</p>
            )}
          </dd>
          {load.value.authed && load.value.scopes.length > 0 && (
            <>
              <dt>Scopes</dt>
              <dd className="cos-gh-scopes">
                {load.value.scopes.map((s) => (
                  <span key={s} className="cos-chip cos-chip-info">
                    {s}
                  </span>
                ))}
              </dd>
            </>
          )}
          {load.value.missing_scopes.length > 0 && (
            <>
              <dt>Missing</dt>
              <dd className="cos-gh-scopes">
                {load.value.missing_scopes.map((s) => (
                  <span key={s} className="cos-chip cos-gh-scope-missing">
                    {s}
                  </span>
                ))}
                <p className="cos-helper-text">
                  Run <code>gh auth refresh -h github.com</code> to add
                  these scopes. <code>read:org</code> is needed for
                  any team-scoped queries; PR-author /
                  review-requested queries work without it.
                </p>
              </dd>
            </>
          )}
        </dl>
      )}
      <div className="cos-form-actions">
        <button
          type="button"
          className="cos-btn cos-btn-ghost"
          onClick={() => setRefreshNonce((n) => n + 1)}
        >
          Refresh
        </button>
      </div>

      <header className="cos-section-head" style={{ marginTop: 24 }}>
        <h3>Velocity preferences</h3>
        <p className="cos-section-lede">
          What appears in Work → PRs / Review. PRs whose author matches
          this list (or whom GitHub flagged as a bot) are hidden by
          default. Toggle below to include them.
        </p>
      </header>
      <dl className="cos-status">
        <dt>Show bot PRs</dt>
        <dd>
          <label className="cos-checkbox">
            <input
              type="checkbox"
              checked={prefs.showBots}
              onChange={(e) =>
                savePrefs({ ...prefs, showBots: e.target.checked })
              }
            />
            <span>Include dependabot, renovate, etc.</span>
          </label>
        </dd>
        <dt>Excluded authors</dt>
        <dd>
          <textarea
            className="cos-text-input"
            rows={4}
            value={draftAuthors}
            onChange={(e) => setDraftAuthors(e.target.value)}
            spellCheck={false}
            aria-label="Excluded authors, one per line"
            placeholder={`dependabot[bot]\nrenovate[bot]\ngithub-actions[bot]`}
          />
          <p className="cos-helper-text">
            One login per line. Case-insensitive. Empty falls back to
            the default list.
          </p>
          <button
            type="button"
            className="cos-btn cos-btn-ghost"
            onClick={saveAuthors}
          >
            Save excluded authors
          </button>
        </dd>
      </dl>
    </section>
  );
}

/**
 * Home strip ordering (B9-CP29). Lets the user reorder the data
 * strips on Home (PRs / Incidents / On-call) with up/down buttons.
 */
function HomeSection() {
  const [order, setOrder] = useState<HomeStripId[]>(
    () => readHomePrefs().stripOrder,
  );
  const move = (id: HomeStripId, delta: -1 | 1) => {
    const next = moveStrip(order, id, delta);
    setOrder(next);
    writeHomePrefs({ stripOrder: next });
  };
  return (
    <section className="cos-section">
      <header className="cos-section-head">
        <h2>Home strips</h2>
        <p className="cos-section-lede">
          Reorder the data strips on Home. Each strip stays hidden
          when its underlying source has nothing to show — order is
          remembered here.
        </p>
      </header>
      <ul className="cos-home-strip-order">
        {order.map((id, ix) => (
          <li key={id} className="cos-home-strip-row">
            <span>{STRIP_LABELS[id]}</span>
            <span className="cos-home-strip-actions">
              <button
                type="button"
                className="cos-btn cos-btn-ghost"
                onClick={() => move(id, -1)}
                disabled={ix === 0}
                aria-label={`Move ${STRIP_LABELS[id]} up`}
              >
                ↑
              </button>
              <button
                type="button"
                className="cos-btn cos-btn-ghost"
                onClick={() => move(id, 1)}
                disabled={ix === order.length - 1}
                aria-label={`Move ${STRIP_LABELS[id]} down`}
              >
                ↓
              </button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * On-call (B9-CP3). PRD-108 §11 — direct PagerDuty REST API
 * integration. Token entry + Probe (whoami round-trip) so users
 * can confirm the token works without the rest of the surface
 * silently failing.
 */
type PagingStatus = {
  provider: string;
  has_token: boolean;
  whoami: { Ok: string } | { Err: string } | null;
};

function PagingSettings() {
  const [status, setStatus] = useState<PagingStatus | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [probeMsg, setProbeMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const v = await invoke<PagingStatus>("paging_status", { probe: false });
      setStatus(v);
    } catch (err) {
      setProbeMsg(`status failed: ${String(err)}`);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const save = async () => {
    if (!draft.trim()) return;
    setBusy(true);
    try {
      await invoke("paging_token_set", { token: draft.trim() });
      setDraft("");
      await refresh();
    } catch (err) {
      setProbeMsg(`save failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const probe = async () => {
    setBusy(true);
    setProbeMsg(null);
    try {
      const v = await invoke<PagingStatus>("paging_status", { probe: true });
      setStatus(v);
      if (v.whoami && "Ok" in v.whoami) {
        setProbeMsg(`✓ ${v.whoami.Ok}`);
      } else if (v.whoami && "Err" in v.whoami) {
        setProbeMsg(`✗ ${v.whoami.Err}`);
      }
    } catch (err) {
      setProbeMsg(`probe failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    try {
      await invoke("paging_token_clear");
      await refresh();
      setProbeMsg("token cleared");
    } catch (err) {
      setProbeMsg(`clear failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="cos-section-head" style={{ marginTop: 24 }}>
        <h3>On-call (PagerDuty)</h3>
        <p className="cos-section-lede">
          Direct PagerDuty REST API. Generate a personal API token in
          PagerDuty (User → My Profile → User Settings → API Access);
          read-only scope is sufficient. Stored in your Keychain.
          PRD-108 §11.
        </p>
      </header>
      <dl className="cos-status">
        <dt>Token</dt>
        <dd className="cos-claude-key-row">
          <input
            type="password"
            className="cos-text-input"
            placeholder={status?.has_token ? "stored — leave blank to keep" : "u+xxxxxxxxxxxxxxxxxxxx"}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={busy}
            spellCheck={false}
            aria-label="PagerDuty API token"
          />
          <button
            type="button"
            className="cos-btn"
            onClick={save}
            disabled={busy || !draft.trim()}
          >
            Save
          </button>
          {status?.has_token && (
            <button
              type="button"
              className="cos-btn cos-btn-ghost"
              onClick={clear}
              disabled={busy}
            >
              Clear
            </button>
          )}
        </dd>
        <dt>Probe</dt>
        <dd>
          <button
            type="button"
            className="cos-btn cos-btn-ghost"
            onClick={probe}
            disabled={busy || !status?.has_token}
            title="Round-trip /users/me to confirm the token works"
          >
            {busy ? "Probing…" : "Test connection"}
          </button>
          {probeMsg && <p className="cos-helper-text">{probeMsg}</p>}
        </dd>
      </dl>
    </>
  );
}

/**
 * Ops settings (B8-CP21). PRD-108 §3 #10 — manual service→team map
 * for orgs without an authoritative service catalogue. Once the
 * Health tab grows a "my team's services" filter (post-B8), it
 * reads this map.
 */
function OpsSettingsSection() {
  const [prefs, setPrefs] = useState(() => readOpsPrefs());
  const [draftMap, setDraftMap] = useState(() =>
    formatTeamServices(readOpsPrefs().teamServices),
  );
  // Keywords are stored as `string[]`; the textarea edits them as one
  // per line. Round-trip through this draft so an in-progress edit
  // doesn't get re-split mid-typing.
  const [draftKeywords, setDraftKeywords] = useState(() =>
    readOpsPrefs().myPolicyKeywords.join("\n"),
  );

  const save = () => {
    const next: OpsPrefs = {
      myTeam: prefs.myTeam,
      teamServices: parseTeamServices(draftMap),
      homeServiceId: prefs.homeServiceId,
      homeServiceLabel: prefs.homeServiceLabel,
      recentDeploys: prefs.recentDeploys,
      myPolicyKeywords: draftKeywords
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    };
    writeOpsPrefs(next);
    setPrefs(next);
  };

  return (
    <section className="cos-section">
      <header className="cos-section-head">
        <h2>Ops</h2>
        <p className="cos-section-lede">
          Service ownership map for the Health tab. Each line is{" "}
          <code>team: service1, service2</code>. Used to scope
          incidents / Rollbar / Datadog rows to your team once the
          filter ships (post-B8). PRD-108 §3 #10.
        </p>
      </header>

      <PagingSettings />

      <header className="cos-section-head" style={{ marginTop: 24 }}>
        <h3>Pinned service</h3>
        <p className="cos-section-lede">
          PagerDuty service id (e.g. <code>PXXXXXX</code>) used by the
          Home on-call strip. Optional — leave blank to hide the strip.
          PRD-108 §11.
        </p>
      </header>
      <dl className="cos-status">
        <dt>Service id</dt>
        <dd>
          <input
            type="text"
            className="cos-text-input"
            value={prefs.homeServiceId}
            onChange={(e) => setPrefs({ ...prefs, homeServiceId: e.target.value })}
            placeholder="PABCDEF"
            spellCheck={false}
            aria-label="Pinned PagerDuty service id"
          />
        </dd>
        <dt>Label</dt>
        <dd>
          <input
            type="text"
            className="cos-text-input"
            value={prefs.homeServiceLabel}
            onChange={(e) =>
              setPrefs({ ...prefs, homeServiceLabel: e.target.value })
            }
            placeholder="Payments"
            spellCheck={false}
            aria-label="Pinned service label"
          />
          <p className="cos-helper-text">
            Shown on the Home strip. Defaults to the PD service summary
            if blank.
          </p>
        </dd>
      </dl>
      <dl className="cos-status">
        <dt>My team</dt>
        <dd>
          <input
            type="text"
            className="cos-text-input"
            value={prefs.myTeam}
            onChange={(e) => setPrefs({ ...prefs, myTeam: e.target.value })}
            placeholder="payments-core"
            spellCheck={false}
            aria-label="My team"
          />
          <p className="cos-helper-text">
            The team you're scoped to by default. Save with the button
            below.
          </p>
        </dd>
        <dt>Service ownership</dt>
        <dd>
          <textarea
            className="cos-text-input"
            rows={6}
            value={draftMap}
            onChange={(e) => setDraftMap(e.target.value)}
            spellCheck={false}
            aria-label="Service ownership map"
            placeholder={`payments-core: pay-svc, ledger-svc\npayments-atwork: dte-svc`}
          />
          <p className="cos-helper-text">
            Lines starting with <code>#</code> are comments.
          </p>
        </dd>
        <dt>On-call relevance</dt>
        <dd>
          <textarea
            className="cos-text-input"
            rows={5}
            value={draftKeywords}
            onChange={(e) => setDraftKeywords(e.target.value)}
            spellCheck={false}
            aria-label="On-call relevance keywords"
            placeholder={`payments\ndder\ngrowth\ndte`}
          />
          <p className="cos-helper-text">
            One keyword per line. The On-call tab pins escalation
            policies that match any keyword (case-insensitive
            substring) at the top, under "My teams". Falls back to{" "}
            <code>My team</code> when blank.
          </p>
        </dd>
      </dl>
      <div className="cos-form-actions">
        <button type="button" className="cos-btn" onClick={save}>
          Save Ops settings
        </button>
      </div>
    </section>
  );
}

/**
 * Calendar config — moved out of the inline panel inside Meetings/
 * Calendar so settings live in one place. Shown as its own Settings
 * section. The Calendar surface deep-links here via cos:goto +
 * cos:settings-section events.
 */
function CalendarSection() {
  const [load, setLoad] = useState<Status<CalendarConfig>>({ kind: "pending" });
  const [icsUrl, setIcsUrl] = useState("");
  const [transport, setTransport] = useState<"ics" | "eventkit">("eventkit");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    invoke<CalendarConfig>("calendar_config_get")
      .then((value) => {
        setLoad({ kind: "ok", value });
        setIcsUrl(value.ics_url);
        setTransport(value.transport === "ics" ? "ics" : "eventkit");
      })
      .catch((error) => setLoad({ kind: "error", error: String(error) }));
  }, []);

  const save = async () => {
    setBusy(true);
    setSaved(false);
    try {
      const next = await invoke<CalendarConfig>("calendar_config_set", {
        config: { ics_url: icsUrl.trim(), transport },
      });
      setLoad({ kind: "ok", value: next });
      setSaved(true);
    } catch (error) {
      setLoad({ kind: "error", error: String(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="cos-section">
      <header className="cos-section-head">
        <h2>Calendar</h2>
        <p className="cos-section-lede">
          Where the Calendar surface and Home's "Today's calendar" stack
          pull events from. Changes apply on the next refresh.
        </p>
      </header>
      {load.kind === "pending" && <p>Loading…</p>}
      {load.kind === "error" && (
        <p className="cos-error">Could not load: {load.error}</p>
      )}
      {load.kind !== "pending" && (
        <div className="cos-form">
          <fieldset className="cos-calendar-transport">
            <legend>Source</legend>
            <label>
              <input
                type="radio"
                name="cos-cal-settings-transport"
                checked={transport === "eventkit"}
                onChange={() => setTransport("eventkit")}
              />
              <span>
                <strong>macOS Calendar (recommended)</strong> — reads from
                Calendar.app, which already syncs your Google + work
                calendars. First refresh prompts for Calendar access.
              </span>
            </label>
            <label>
              <input
                type="radio"
                name="cos-cal-settings-transport"
                checked={transport === "ics"}
                onChange={() => setTransport("ics")}
              />
              <span>ICS subscription URL</span>
            </label>
          </fieldset>
          <label htmlFor="cos-settings-ics-url">
            ICS URL{transport === "eventkit" ? " (fallback)" : ""}
          </label>
          <input
            id="cos-settings-ics-url"
            type="url"
            value={icsUrl}
            onChange={(e) => setIcsUrl(e.target.value)}
            placeholder="https://calendar.google.com/calendar/ical/.../basic.ics"
          />
          <p className="cos-helper-text">
            Use the <strong>Secret address in iCal format</strong> from
            Google Calendar → Settings → Settings for my calendars →{" "}
            <em>[your calendar]</em> → Integrate calendar. The Public
            address only emits free/busy. Stored locally in{" "}
            <code>calendar.json</code>.
          </p>
          <div className="cos-form-actions">
            <button
              type="button"
              className="cos-btn"
              onClick={save}
              disabled={busy || (transport === "ics" && !icsUrl.trim())}
            >
              {busy ? "saving…" : "save"}
            </button>
            {saved && (
              <span className="cos-form-saved">saved</span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

type PluginRow = {
  slug: string;
  name: string;
  version: string | null;
  description: string | null;
  capabilities: string[];
  manifest_ok: boolean;
  manifest_error: string | null;
};

/** Capability strings the loader recognizes today. Mirrors the Rust
 *  `KNOWN_CAPABILITIES` table — must stay in sync. Anything not in
 *  this set renders with the "unknown" tone in the chip strip. */
export const KNOWN_PLUGIN_CAPABILITIES: ReadonlySet<string> = new Set([
  "tasks.read",
  "tasks.write",
  "content.read",
  "content.write",
  "calendar.read",
  "claude.skills",
  "settings.read",
  "audit.read",
]);

export function isKnownCapability(name: string): boolean {
  return KNOWN_PLUGIN_CAPABILITIES.has(name);
}

/**
 * Plugins section (M10a — first checkpoint of PRD-104). Today this is
 * read-only — list whatever's under `<app_data>/plugins/` and show
 * either a populated list or a friendly empty state pointing the user
 * at the doc. Loading + capability surface arrive in later checkpoints.
 */
/**
 * About card at the top of the General tab. Surfaces the build
 * version + on-disk DB path so onboarding has somewhere obvious to
 * read these. Until CP5 they only existed deep in Diagnostics.
 */
function AboutSection({ info }: { info: Status<BackendInfo> }) {
  return (
    <section className="cos-section">
      <header className="cos-section-head">
        <h2>About</h2>
        <p className="cos-section-lede">
          What you're running, and where its data lives.
        </p>
      </header>
      <dl className="cos-status">
        <dt>Build</dt>
        <dd>{render(info, (v) => v.version)}</dd>
        <dt>Built by</dt>
        <dd>
          {render(info, (v) => `${v.built_by} · with ${v.built_with}`)}
        </dd>
        <dt>Database</dt>
        <dd>
          {info.kind === "ok" ? (
            <code className="cos-path">{info.value.db_path}</code>
          ) : (
            <span className="cos-pending">—</span>
          )}
        </dd>
      </dl>
    </section>
  );
}

// ── Updates section (PRD-103 / Phase 1B) ──────────────────────────────────────

function UpdatesSection() {
  const state = useUpdateState();
  const [autoInstall, setAutoInstall] = useState(() => readAutoInstall());

  const handleCheck = useCallback(async () => {
    await checkForUpdate({ silent: false });
  }, []);

  const lastCheckText = (() => {
    if (state.kind === "checking") return "checking…";
    if (state.kind === "uptodate")
      return `up to date as of ${formatRelativeTimeShort(state.checkedAt)}`;
    if (state.kind === "unconfigured")
      return "auto-updates aren't published yet for this build";
    if (state.kind === "error")
      return `last check failed: ${state.message}`;
    if (state.kind === "available")
      return `v${state.version} available`;
    if (state.kind === "downloading")
      return `downloading v${state.version}…`;
    if (state.kind === "ready") return `ready to install v${state.version}`;
    if (state.kind === "installing") return "installing…";
    return "not yet checked";
  })();

  return (
    <section className="cos-section">
      <header className="cos-section-head">
        <h2>Updates</h2>
        <p className="cos-section-lede">
          Updates download silently in the background and install on
          your next quit. Your data stays put — updates only swap the
          app bundle, never touch your notes, tasks, or settings.
        </p>
      </header>
      <dl className="cos-status">
        <dt>Status</dt>
        <dd>{lastCheckText}</dd>
      </dl>
      <div className="cos-data-folder-actions">
        <button
          type="button"
          className="cos-btn"
          onClick={handleCheck}
          disabled={
            state.kind === "checking" || state.kind === "downloading"
          }
        >
          {state.kind === "checking" ? "checking…" : "check for updates"}
        </button>
        {state.kind === "available" && (
          <button
            type="button"
            className="cos-btn cos-btn-primary"
            onClick={() => downloadAvailableUpdate()}
          >
            download v{state.version}
          </button>
        )}
        {state.kind === "ready" && (
          <button
            type="button"
            className="cos-btn cos-btn-primary"
            onClick={() => relaunchToInstall()}
          >
            restart now
          </button>
        )}
      </div>
      <div className="cos-data-folder-actions">
        <label>
          <input
            type="checkbox"
            checked={autoInstall}
            onChange={(e) => {
              setAutoInstall(e.target.checked);
              writeAutoInstall(e.target.checked);
            }}
          />
          {" "}Check for updates automatically on launch
        </label>
      </div>
      {state.kind === "available" && state.notes && (
        <div className="cos-section-note">
          <strong>What's new:</strong>
          <pre className="cos-update-notes">
            {state.notes.replace(/^urgent:\s*/i, "")}
          </pre>
        </div>
      )}
      {state.kind === "unconfigured" && (
        <p className="cos-helper-text">
          The updater endpoint isn't serving a release manifest yet —
          this happens for personal builds and freshly forked installs.
          Rebuild via <code>npm run tauri build</code> when there's a
          new version, or set up signed releases at{" "}
          <code>tauri.conf.json &gt; plugins.updater</code>.
        </p>
      )}
    </section>
  );
}

function formatRelativeTimeShort(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 60_000) return "just now";
  if (delta < 60 * 60_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 24 * 60 * 60_000) return `${Math.floor(delta / (60 * 60_000))}h ago`;
  return new Date(ms).toLocaleString();
}

// ── Data folder section (PRD-103 / installation-rollout 0.1) ──────────────────

type ContentRootInfo = {
  current: string;
  default: string;
  has_choice: boolean;
  env_override: boolean;
};

function DataFolderSection() {
  const [info, setInfo] = useState<ContentRootInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingPath, setPendingPath] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const v = await invoke<ContentRootInfo>("content_root_info");
      setInfo(v);
    } catch (err) {
      setError(`Couldn't read data-folder state: ${String(err)}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function pickFolder() {
    setError(null);
    try {
      // Lazy-import the dialog plugin so the bundle doesn't pay
      // for it on Home / first-paint.
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        directory: true,
        multiple: false,
        title: "Choose your Chief of Staff data folder",
        defaultPath: info?.current,
      });
      if (typeof picked !== "string") return; // user cancelled
      setPendingPath(picked);
    } catch (err) {
      setError(`Couldn't open the folder picker: ${String(err)}`);
    }
  }

  async function applyPath(path: string) {
    setBusy(true);
    setError(null);
    try {
      const canonical = await invoke<string>("content_root_set", {
        root: path,
      });
      // Update local state so the user sees the new value immediately;
      // the path won't actually take effect until relaunch.
      setInfo((prev) =>
        prev ? { ...prev, current: canonical, has_choice: true } : prev,
      );
      setPendingPath(null);
    } catch (err) {
      setError(`Couldn't save the choice: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function resetToDefault() {
    if (!info) return;
    await applyPath(info.default);
  }

  async function revealInFinder() {
    if (!info) return;
    try {
      // Lazy-import opener so the bundle doesn't pay until needed.
      const { openPath } = await import("@tauri-apps/plugin-opener");
      await openPath(info.current);
    } catch (err) {
      setError(`Couldn't open the folder: ${String(err)}`);
    }
  }

  if (!info) {
    return (
      <section className="cos-section">
        <header className="cos-section-head">
          <h2>Data folder</h2>
          <p className="cos-section-lede">Loading…</p>
        </header>
      </section>
    );
  }

  const status = info.env_override
    ? "Environment override (COS_CONTENT_ROOT)"
    : info.has_choice
      ? "Saved choice"
      : "Default";

  return (
    <section className="cos-section">
      <header className="cos-section-head">
        <h2>Data folder</h2>
        <p className="cos-section-lede">
          Where your markdown notes, sessions, and the SQLite task DB live.
          Changes take effect after the next launch.
        </p>
      </header>
      <dl className="cos-status">
        <dt>Active path</dt>
        <dd>
          <code className="cos-path">{info.current}</code>{" "}
          <span className="cos-content-muted">· {status}</span>
        </dd>
        <dt>Default</dt>
        <dd>
          <code className="cos-path">{info.default}</code>
        </dd>
      </dl>
      {info.env_override && (
        <p className="cos-section-note">
          The <code>COS_CONTENT_ROOT</code> environment variable is set
          for this session and overrides any saved choice. Saving a new
          path here still persists; it will take effect once the env
          var is unset.
        </p>
      )}
      {pendingPath && (
        <div className="cos-data-folder-pending">
          <p>
            Save{" "}
            <code className="cos-path">{pendingPath}</code> as the new
            data folder?
          </p>
          <div className="cos-data-folder-actions">
            <button
              type="button"
              className="cos-btn"
              onClick={() => setPendingPath(null)}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="cos-btn cos-btn-primary"
              onClick={() => applyPath(pendingPath)}
              disabled={busy}
            >
              Save
            </button>
          </div>
        </div>
      )}
      {!pendingPath && (
        <div className="cos-data-folder-actions">
          <button type="button" className="cos-btn" onClick={pickFolder}>
            Choose folder…
          </button>
          <button
            type="button"
            className="cos-btn"
            onClick={revealInFinder}
          >
            Reveal in Finder
          </button>
          {info.has_choice && (
            <button
              type="button"
              className="cos-btn cos-btn-ghost"
              onClick={resetToDefault}
              disabled={busy}
            >
              Reset to default
            </button>
          )}
        </div>
      )}
      {error && (
        <p className="cos-section-note cos-section-note-error">{error}</p>
      )}
      {info.has_choice && !info.env_override && (
        <p className="cos-section-note">
          A relaunch is needed for path changes to take full effect — the
          editor's open document and the v1 task DB pointer are wired to
          the path that was active at startup.
        </p>
      )}
    </section>
  );
}

// ── Local Network Section ─────────────────────────────────────────────────────

type LocalNetStatus = {
  enabled: boolean;
  vite_port: number;
  bridge_port: number;
  lan_ip: string | null;
  setup_url: string | null;
  available: boolean;
};

function LocalNetworkSection() {
  const [status, setStatus] = useState<LocalNetStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadStatus() {
    const s = await invoke<LocalNetStatus>("local_net_status");
    setStatus(s);
    if (s.setup_url) {
      generateQr(s.setup_url);
    } else {
      setQrDataUrl(null);
    }
  }

  async function generateQr(url: string) {
    try {
      const QRCode = await import("qrcode");
      const dataUrl = await QRCode.toDataURL(url, { width: 200, margin: 1 });
      setQrDataUrl(dataUrl);
    } catch {
      setQrDataUrl(null);
    }
  }

  useEffect(() => { loadStatus(); }, []);

  async function handleToggle() {
    if (!status) return;
    setBusy(true);
    setError(null);
    try {
      const next = await invoke<LocalNetStatus>(
        status.enabled ? "local_net_disable" : "local_net_enable",
      );
      setStatus(next);
      if (next.setup_url) {
        generateQr(next.setup_url);
      } else {
        setQrDataUrl(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleRotate() {
    if (!status) return;
    if (!confirm(
      "Rotate the auth token? Any phone or tablet currently paired will lose access and need to re-scan the QR code.",
    )) return;
    setBusy(true);
    setError(null);
    try {
      const next = await invoke<LocalNetStatus>("local_net_rotate_token");
      setStatus(next);
      if (next.setup_url) {
        generateQr(next.setup_url);
      } else {
        setQrDataUrl(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="cos-section">
      <header className="cos-section-head">
        <h2>Local Network</h2>
        <p className="cos-section-lede">
          Access your data from a phone or tablet on the same Wi-Fi network.
          Read-only — write actions are not exposed. Off by default; you must
          enable it each session.
        </p>
      </header>

      {status == null ? (
        <p className="cos-muted">Loading…</p>
      ) : !status.available ? (
        <p className="cos-muted">
          Local network access is only available in development builds.
        </p>
      ) : (
        <>
          <div className="cos-field-row" style={{ marginBottom: "1rem" }}>
            <label className="cos-label">
              <input
                type="checkbox"
                checked={status.enabled}
                disabled={busy}
                onChange={handleToggle}
                style={{ marginRight: "0.5rem" }}
              />
              Enable local network access
            </label>
          </div>

          {error && (
            <div
              className="cos-muted"
              style={{ marginBottom: "0.75rem", color: "var(--cos-red, red)", fontSize: "0.85rem" }}
            >
              {error}
            </div>
          )}

          {status.enabled && (
            <>
              <div className="cos-field-row">
                <span className="cos-label">Mobile URL port</span>
                <span className="cos-value">{status.vite_port}</span>
              </div>
              <div className="cos-field-row">
                <span className="cos-label">Bridge port (loopback only)</span>
                <span className="cos-value">{status.bridge_port}</span>
              </div>
              {status.lan_ip && (
                <div className="cos-field-row">
                  <span className="cos-label">This device's IP</span>
                  <span className="cos-value cos-mono">{status.lan_ip}</span>
                </div>
              )}

              {status.setup_url ? (
                <div style={{ marginTop: "1.25rem" }}>
                  <p className="cos-label" style={{ marginBottom: "0.5rem" }}>
                    Scan to connect your mobile browser
                  </p>
                  {qrDataUrl ? (
                    <img
                      src={qrDataUrl}
                      alt="QR code for local network setup"
                      style={{ display: "block", borderRadius: 6 }}
                    />
                  ) : (
                    <p className="cos-muted">Generating QR code…</p>
                  )}
                  <p
                    className="cos-muted cos-mono"
                    style={{ marginTop: "0.5rem", wordBreak: "break-all", fontSize: "0.75rem" }}
                  >
                    {status.setup_url}
                  </p>
                  <p className="cos-muted" style={{ marginTop: "0.5rem", fontSize: "0.8rem" }}>
                    Scan with your phone or tablet. The auth token is stored
                    automatically and used for subsequent requests. The token
                    persists until you rotate it or close the app.
                  </p>
                </div>
              ) : (
                <p className="cos-muted" style={{ marginTop: "0.75rem" }}>
                  Could not detect LAN IP. Make sure you're connected to Wi-Fi.
                </p>
              )}

              <div style={{ marginTop: "1rem" }}>
                <button
                  className="cos-btn cos-btn--sm"
                  onClick={handleRotate}
                  disabled={busy}
                >
                  Rotate auth token
                </button>
                <p className="cos-muted" style={{ marginTop: "0.4rem", fontSize: "0.8rem" }}>
                  Use after losing a paired device. Generates a new token and
                  forces every paired device to re-scan.
                </p>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}

function PluginsSection() {
  const [load, setLoad] = useState<Status<PluginRow[]>>({ kind: "pending" });
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await invoke<PluginRow[]>("plugin_list");
        if (!cancelled) setLoad({ kind: "ok", value: rows });
      } catch (err) {
        if (!cancelled) setLoad({ kind: "error", error: String(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshNonce]);

  return (
    <section className="cos-section">
      <header className="cos-section-head">
        <h2>Plugins</h2>
        <p className="cos-section-lede">
          Bundled and user-installed plugins discovered under{" "}
          <code>plugins/</code> in the app data directory. The runtime
          scaffold ships now; loading + capability gating arrive in a
          later checkpoint (PRD-104).
        </p>
      </header>
      {load.kind === "pending" && (
        <p className="cos-pending">Reading plugin manifests…</p>
      )}
      {load.kind === "error" && (
        <p className="cos-bad">error: {load.error}</p>
      )}
      {load.kind === "ok" && load.value.length === 0 && (
        <div className="cos-empty">
          <p>No plugins installed.</p>
          <p className="cos-helper-text">
            The plugin runtime is in place. Built-in features (Tasks,
            People, Calendar) extract here in Phase 1 (PRD-104). User
            plugins get a manifest at{" "}
            <code>&lt;app_data&gt;/plugins/&lt;slug&gt;/manifest.toml</code>.
          </p>
        </div>
      )}
      {load.kind === "ok" && load.value.length > 0 && (
        <ul className="cos-plugin-list">
          {load.value.map((p) => (
            <li
              key={p.slug}
              className={`cos-plugin-row${p.manifest_ok ? "" : " is-broken"}`}
            >
              <div className="cos-plugin-head">
                <span className="cos-plugin-name">{p.name}</span>
                {p.version && (
                  <span className="cos-plugin-version">v{p.version}</span>
                )}
                <span className="cos-plugin-slug">{p.slug}</span>
              </div>
              {p.description && (
                <p className="cos-plugin-desc">{p.description}</p>
              )}
              {p.capabilities.length > 0 && (
                <ul
                  className="cos-plugin-caps"
                  aria-label="Declared capabilities"
                >
                  {p.capabilities.map((cap) => {
                    const known = isKnownCapability(cap);
                    return (
                      <li
                        key={cap}
                        className={`cos-plugin-cap${
                          known ? "" : " is-unknown"
                        }`}
                        title={
                          known
                            ? "Known capability"
                            : "Unknown capability — runtime won't recognize this; review before enabling."
                        }
                      >
                        {cap}
                      </li>
                    );
                  })}
                </ul>
              )}
              {!p.manifest_ok && p.manifest_error && (
                <p className="cos-plugin-error">{p.manifest_error}</p>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="cos-form-actions">
        <button
          type="button"
          className="cos-btn cos-btn-ghost"
          onClick={() => setRefreshNonce((n) => n + 1)}
          disabled={load.kind === "pending"}
        >
          refresh
        </button>
        <button
          type="button"
          className="cos-btn cos-btn-ghost"
          onClick={async () => {
            try {
              await invoke("plugin_dir_open");
            } catch {
              // Silent — failure mode is "open" not on PATH, which
              // we can't recover from here.
            }
          }}
          title="Reveal the plugin directory in Finder"
        >
          open folder
        </button>
      </div>
    </section>
  );
}
