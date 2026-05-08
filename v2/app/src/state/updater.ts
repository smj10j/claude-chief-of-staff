/**
 * Silent auto-updater (PRD-103 Phase 1B).
 *
 * Wraps `@tauri-apps/plugin-updater` with the policy described in the
 * rollout doc:
 *   - Default ON. The user can disable in Settings → Updates;
 *     persisted to localStorage as `cos.update.auto-install.v1`.
 *   - Check on app startup (a few seconds after first paint, so the
 *     check doesn't compete with editor mount).
 *   - Download silently in the background.
 *   - Show a soft "Update ready" toast / banner when complete; never
 *     a modal except for `urgent` flagged updates.
 *   - Install on next clean quit OR when the user picks "Restart now."
 *   - Never touch user data — the install path swaps the .app bundle
 *     only. Schema migrations are gated at app boot, not here.
 *
 * The endpoint + pubkey come from `tauri.conf.json` plugins.updater.
 * If `active: false` (current default; see config note in §1B), no
 * network call is made and `check()` returns null fast.
 */

import { useSyncExternalStore } from "react";

const AUTO_INSTALL_KEY = "cos.update.auto-install.v1";

/**
 * When the iPad/browser bridge is active, the updater is a no-op: the
 * mobile client has no business updating the macOS app bundle, and
 * `plugin:updater|*` commands aren't routed through the HTTP bridge
 * anyway. Detected by the localStorage keys the shim sets on setup
 * (`cos_local_net_token` + `cos_local_net_api`).
 */
function isBridgeMode(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return (
      window.localStorage.getItem("cos_local_net_token") !== null &&
      window.localStorage.getItem("cos_local_net_api") !== null
    );
  } catch {
    return false;
  }
}

export function readAutoInstall(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(AUTO_INSTALL_KEY);
    if (raw === null) return true; // default on
    return raw !== "false";
  } catch {
    return true;
  }
}

export function writeAutoInstall(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AUTO_INSTALL_KEY, enabled ? "true" : "false");
  } catch {
    // Private mode — best-effort.
  }
}

/**
 * Update state machine. The frontend subscribes via `useUpdateState`
 * to render the appropriate banner / toast / nothing.
 *
 * Transitions:
 *   idle → checking (on startup, on manual "Check now")
 *   checking → uptodate | available | error
 *   available → downloading → ready | error
 *   ready → installing → ... (process exits, app relaunches)
 */
export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "uptodate"; checkedAt: number }
  | { kind: "available"; version: string; notes: string; urgent: boolean }
  | {
      kind: "downloading";
      version: string;
      notes: string;
      urgent: boolean;
      bytesDone: number;
      bytesTotal: number | null;
    }
  | { kind: "ready"; version: string; notes: string; urgent: boolean }
  | { kind: "installing" }
  /**
   * `unconfigured` — the updater endpoint isn't serving releases yet
   * (404, missing JSON manifest, placeholder endpoint, missing pubkey,
   * etc.). Distinct from `error` so the UI can render "auto-updates
   * aren't enabled in this build" instead of a scary error message.
   * For personal builds + freshly forked installs this is the
   * expected steady state until a release is published.
   */
  | { kind: "unconfigured"; reason: string; checkedAt: number }
  | { kind: "error"; message: string; checkedAt: number };

/**
 * Pattern-match the underlying tauri-plugin-updater error message and
 * decide whether it really is an error or just "no release published
 * yet." Exported so tests can pin the matchers without re-running
 * the network call.
 */
export function classifyUpdateError(
  message: string,
): "unconfigured" | "error" {
  const m = message.toLowerCase();
  // Tauri's updater plugin returns this exact phrase when the endpoint
  // either 404s, returns empty content, or returns non-manifest JSON.
  // For the common case of "I haven't published a release yet" this
  // is what fires.
  if (m.includes("could not fetch a valid release json")) return "unconfigured";
  if (m.includes("releases/latest/download/latest.json") && m.includes("404"))
    return "unconfigured";
  if (m.includes("no such host") || m.includes("dns") || m.includes("getaddrinfo"))
    return "error"; // network — surface this so the user can check it
  return "error";
}

let current: UpdateState = { kind: "idle" };
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

function set(next: UpdateState): void {
  current = next;
  notify();
}

export function getUpdateState(): UpdateState {
  return current;
}

export function useUpdateState(): UpdateState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
    () => current,
  );
}

/**
 * Check for an update once. The `silent` flag suppresses transitions
 * to `error` / `uptodate` that the user didn't ask for — a startup
 * check that finds nothing should leave the state at `idle`, not
 * paint a "you're up to date" banner.
 *
 * Returns the new state for callers that want to chain (e.g., the
 * Settings "Check now" button).
 */
export async function checkForUpdate(opts: { silent?: boolean } = {}): Promise<
  UpdateState
> {
  if (current.kind === "checking" || current.kind === "downloading") {
    return current;
  }
  if (isBridgeMode()) {
    const next: UpdateState = opts.silent
      ? { kind: "idle" }
      : { kind: "unconfigured", reason: "bridge mode", checkedAt: Date.now() };
    set(next);
    return next;
  }
  set({ kind: "checking" });
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const upd = await check();
    if (!upd) {
      const next: UpdateState = opts.silent
        ? { kind: "idle" }
        : { kind: "uptodate", checkedAt: Date.now() };
      set(next);
      return next;
    }
    // The PRD reserves an `urgent` flag in the manifest for safety
    // fixes; the plugin doesn't surface custom fields directly, but
    // notes can carry an "URGENT:" prefix as a v1 hack while we
    // shape the manifest schema.
    const urgent =
      typeof upd.body === "string" && /^urgent:/i.test(upd.body.trim());
    const next: UpdateState = {
      kind: "available",
      version: upd.version,
      notes: upd.body ?? "",
      urgent,
    };
    set(next);
    return next;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    const classification = classifyUpdateError(message);
    const next: UpdateState =
      classification === "unconfigured"
        ? { kind: "unconfigured", reason: message, checkedAt: Date.now() }
        : { kind: "error", message, checkedAt: Date.now() };
    if (!opts.silent) set(next);
    else set({ kind: "idle" });
    return next;
  }
}

/**
 * Download the available update silently. Transitions through
 * `downloading` (with progress) and lands on `ready`. The user
 * can choose "Restart now" or wait for the next clean quit.
 */
export async function downloadAvailableUpdate(): Promise<UpdateState> {
  if (current.kind !== "available") return current;
  if (isBridgeMode()) return current;
  const meta = current;
  set({
    kind: "downloading",
    version: meta.version,
    notes: meta.notes,
    urgent: meta.urgent,
    bytesDone: 0,
    bytesTotal: null,
  });
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const upd = await check();
    if (!upd) {
      set({
        kind: "error",
        message: "Update vanished between check and download",
        checkedAt: Date.now(),
      });
      return current;
    }
    let totalBytes: number | null = null;
    let doneBytes = 0;
    await upd.downloadAndInstall((event) => {
      if (event.event === "Started") {
        totalBytes = event.data.contentLength ?? null;
        set({
          kind: "downloading",
          version: meta.version,
          notes: meta.notes,
          urgent: meta.urgent,
          bytesDone: 0,
          bytesTotal: totalBytes,
        });
      } else if (event.event === "Progress") {
        doneBytes += event.data.chunkLength;
        set({
          kind: "downloading",
          version: meta.version,
          notes: meta.notes,
          urgent: meta.urgent,
          bytesDone: doneBytes,
          bytesTotal: totalBytes,
        });
      } else if (event.event === "Finished") {
        // The plugin's `downloadAndInstall` immediately runs the
        // install after this event; from the user's perspective
        // the next thing that happens is the relaunch (or a
        // request to relaunch).
        set({ kind: "installing" });
      }
    });
    return current;
  } catch (error) {
    set({
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
      checkedAt: Date.now(),
    });
    return current;
  }
}

/** Manually relaunch the app — used after `kind: "ready"` to apply
 *  the update right away rather than waiting for the next clean
 *  quit. */
export async function relaunchToInstall(): Promise<void> {
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}

/** Test-only reset. Tests share this module's singleton state, so a
 *  test that lands in `checking` mid-promise leaves the next test
 *  staring at the wrong starting state. The production code should
 *  never call this. */
export function _resetForTest(): void {
  current = { kind: "idle" };
  notify();
}
