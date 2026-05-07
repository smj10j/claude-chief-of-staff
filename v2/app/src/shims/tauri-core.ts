// Commands that must return null (not an empty stub) in browser mode.
const NULL_COMMANDS = new Set([
  "take_open_request",
  "secret_get",
]);

// Write-only commands that are never exposed by the HTTP bridge.
// These return a no-op stub so the UI doesn't crash on settings pages.
const WRITE_COMMANDS = new Set([
  "secret_set", "secret_delete",
  "content_write_file", "content_create_session",
  "content_write_attachment",
  "v1_tasks_complete", "v1_tasks_uncomplete", "v1_tasks_update", "v1_tasks_create",
  "org_save", "org_generate",
  "audit_restore",
  "annotations_save", "annotations_process",
  "paging_token_set", "paging_token_clear",
  "calendar_config_set",
  "claude_config_set", "claude_config_reset",
  "morning_briefing", "task_triage", "weekly_review",
  "publish_to_gdoc", "person_prep", "person_refresh",
  "session_digest",
  "perf_record", "perf_clear",
  "db_encryption_key_ensure",
  "recovery_create_phrase", "recovery_validate_phrase",
  "recovery_mark_confirmed", "recovery_import_phrase", "recovery_reset",
  "planning_epic_update", "velocity_diagnose",
  "planning_epics_run", "planning_jpd_run",
  "ops_incidents_run", "ops_rollbar_run", "ops_monitors_run",
  "jira_my_run", "jira_team_run",
  "gh_pr_detail", "gh_prs_for_author", "gh_pr_ci",
  "content_create_project", "content_delete_project",
  "plugin_dir_open",
  // Local-network bridge management — Tauri-only IPCs. The iPad has no
  // business toggling these; no-op silently.
  "local_net_enable", "local_net_disable", "local_net_rotate_token",
]);

function emptyStub(): unknown {
  return new Proxy([] as unknown[], {
    get(target, prop) {
      if (prop === Symbol.toPrimitive) return (hint: string) => hint === "number" ? 0 : "";
      if (prop === Symbol.toStringTag) return "Array";
      if (prop === "valueOf") return () => "";
      if (prop === "toString") return () => "";

      if (prop in target) {
        const v = (target as unknown as Record<string | symbol, unknown>)[prop];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      }
      return emptyStub();
    },
  });
}

// ── Setup link handling ───────────────────────────────────────────────────────

const STORAGE_KEY_TOKEN = "cos_local_net_token";
const STORAGE_KEY_API   = "cos_local_net_api";

function applySetupParams() {
  const params = new URLSearchParams(window.location.search);
  const setup = params.get("setup");
  const api   = params.get("api");
  if (setup && api) {
    localStorage.setItem(STORAGE_KEY_TOKEN, setup);
    localStorage.setItem(STORAGE_KEY_API, api);
    // Strip query params so reload doesn't re-apply
    const clean = window.location.pathname;
    window.history.replaceState(null, "", clean);
  }
}

applySetupParams();

function getBridgeConfig(): { api: string; token: string } | null {
  const token = localStorage.getItem(STORAGE_KEY_TOKEN);
  const api   = localStorage.getItem(STORAGE_KEY_API);
  if (token && api) return { token, api };
  return null;
}

// ── Synthetic responses for bridge mode ──────────────────────────────────────
// Commands the bridge doesn't dispatch but the shell calls on startup.
// Returning sensible values here lets the shell proceed past its install
// check and mark first-run complete in localStorage.

const BRIDGE_SYNTHETICS: Record<string, unknown> = {
  // Shell probes this on startup; if all_ok the wizard is skipped silently.
  install_status: { all_ok: true, checks: [] },
  // Settings → Diagnostics calls this; return a benign shape.
  backend_version: { version: "bridge", db_path: "", built_by: "", built_with: "" },
  // Settings → Security calls this; hide sensitive state.
  db_encryption_status: { key_present: false, sqlcipher_linked: false, encrypted: false, recovery_confirmed: false },
  recovery_status: { wrapped_present: false, confirmed: false },
  // Calendar config — return empty so the surface renders without errors.
  calendar_config_get: { ics_url: "", transport: "eventkit" },
  // claude config
  claude_config_get: { binary_path: "", extra_args: [] },
  claude_status: { available: false, version: null, config_path: null },
  // Local-network bridge — meaningless on the iPad itself (it IS the
  // mobile client). Return available=false so Settings shows a clean
  // "dev-only" message instead of calling it from a chained Proxy.
  local_net_status: {
    enabled: false,
    vite_port: 1422,
    bridge_port: 1423,
    lan_ip: null,
    setup_url: null,
    available: false,
  },
};

// ── HTTP invoke ───────────────────────────────────────────────────────────────

async function httpInvoke<T>(cmd: string, args?: unknown): Promise<T> {
  const cfg = getBridgeConfig();
  if (!cfg) {
    // No bridge configured — fall through to stub
    if (NULL_COMMANDS.has(cmd)) return null as unknown as T;
    return emptyStub() as unknown as T;
  }

  // Tauri plugin commands (`plugin:foo|bar`) are never routed through
  // the HTTP bridge — they only exist in the native runtime. Returning
  // null here keeps plugin-updater's `check()` from interpreting our
  // emptyStub Proxy as a real Update metadata payload (every Proxy
  // access is truthy, so it would otherwise fabricate an "update
  // available" state and try to download a Resource that doesn't exist).
  if (cmd.startsWith("plugin:")) {
    return null as unknown as T;
  }

  // Return synthetic responses for known-missing commands before hitting
  // the network, so the shell doesn't show the install wizard.
  if (Object.prototype.hasOwnProperty.call(BRIDGE_SYNTHETICS, cmd)) {
    return BRIDGE_SYNTHETICS[cmd] as T;
  }

  const res = await fetch(`${cfg.api}/invoke`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${cfg.token}`,
    },
    body: JSON.stringify({ cmd, args: args ?? {} }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`[bridge] ${cmd}: ${res.status} ${text}`);
  }

  const json = await res.json() as { data?: T; error?: string };

  // Command not in the bridge's dispatch — return null/stub instead of
  // throwing so unexpected callsites don't crash surfaces on mobile.
  if (json.error?.startsWith("unknown or write-only command")) {
    return (NULL_COMMANDS.has(cmd) ? null : emptyStub()) as unknown as T;
  }

  if (json.error) throw new Error(`[bridge] ${cmd}: ${json.error}`);
  return json.data as T;
}

// ── Public invoke ─────────────────────────────────────────────────────────────

export const invoke = async <T>(cmd: string, args?: unknown): Promise<T> => {
  if (NULL_COMMANDS.has(cmd)) return null as unknown as T;
  if (WRITE_COMMANDS.has(cmd)) return emptyStub() as unknown as T;
  return httpInvoke<T>(cmd, args);
};

// ── Stubs for Tauri-only constructs ──────────────────────────────────────────
// Plugins like @tauri-apps/plugin-updater import Resource and Channel from
// @tauri-apps/api/core at module-load time. They never actually run in
// browser-bridge mode, but their import must resolve or the dev server fails
// dependency optimization. These are no-op stubs.

export class Resource {
  #rid: number;
  constructor(rid: number) {
    this.#rid = rid;
  }
  get rid(): number {
    return this.#rid;
  }
  async close(): Promise<void> {
    // no-op in browser mode
  }
}

export class Channel<T = unknown> {
  id = 0;
  onmessage: (response: T) => void = () => {};
  toJSON(): string {
    return `__CHANNEL__:${this.id}`;
  }
}

export function transformCallback<T = unknown>(
  callback?: (response: T) => void,
  _once = false,
): number {
  void callback;
  return 0;
}

export function convertFileSrc(filePath: string, _protocol = "asset"): string {
  return filePath;
}

export function isTauri(): boolean {
  return false;
}

export class PluginListener {
  plugin: string;
  event: string;
  channelId: number;
  constructor(plugin: string, event: string, channelId: number) {
    this.plugin = plugin;
    this.event = event;
    this.channelId = channelId;
  }
  async unregister(): Promise<void> {
    // no-op in browser mode
  }
}

export async function addPluginListener<T = unknown>(
  plugin: string,
  event: string,
  _cb: (payload: T) => void,
): Promise<PluginListener> {
  return new PluginListener(plugin, event, 0);
}

export type PermissionState = "granted" | "denied" | "prompt" | "prompt-with-rationale";

export async function checkPermissions<T>(_plugin: string): Promise<T> {
  return emptyStub() as unknown as T;
}

export async function requestPermissions<T>(_plugin: string): Promise<T> {
  return emptyStub() as unknown as T;
}
