/**
 * PRD-v2-117 Stage 3 — TabsState persistence.
 *
 * Reads/writes the persisted tab strip to localStorage. Handles
 * versioned migration (PRD §4.5), corrupt-blob quarantine, the
 * cleanQuit marker (PRD §4.5), and the size budget (PRD §3 row #18).
 *
 * The module is pure helpers + a thin localStorage wrapper —
 * nothing React-specific. Shell.tsx wires the lifecycle (read on
 * mount, debounced writes on state change, flush on beforeunload /
 * before-quit).
 */

import {
  RECENTLY_CLOSED_MAX,
  type TabState,
  type TabsState,
} from "./tabs";

export const STORAGE_KEY = "cos.tabs.v1";
export const QUARANTINE_KEY = "cos.tabs.v1.quarantine";
export const QUARANTINE_TS_KEY = "cos.tabs.v1.quarantine.ts";
export const CRASH_SNAPSHOT_KEY = "cos.tabs.v1.crash-snapshot";
export const CRASH_SNAPSHOT_TS_KEY = "cos.tabs.v1.crash-snapshot.ts";

/** Current persisted-blob version. Bump when the on-disk shape
 *  changes incompatibly; register a forward migration in
 *  `MIGRATIONS` below. */
export const CURRENT_VERSION = 1 as const;
export type Version = typeof CURRENT_VERSION;

/** PRD §3 row #18 size targets. */
export const SIZE_TARGET_BYTES = 256_000;
export const SIZE_HARD_LIMIT_BYTES = 1_000_000;

/** PRD §4.5 quarantine cleanup window — diagnostic blobs older than
 *  this on the *next* clean Cmd+Q are pruned. */
export const QUARANTINE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The persisted shape on disk. Mirrors PRD §4.5; `version` is the
 * migration anchor.
 */
export type PersistedTabs = {
  version: Version;
  tabs: TabState[];
  activeTabId: string;
  recentlyClosed: { state: TabState; closedAt: string }[];
  /** True iff the previous quit fired the clean-quit lifecycle hook.
   *  Absent or false means the app crashed; the launch flow shows a
   *  one-time restore prompt (PRD §4.5). */
  cleanQuit: boolean;
};

/**
 * Result of `readPersistedTabs`. Distinguishes happy-path restore
 * from the various recovery paths the launch flow needs to react
 * to. The Shell wires UI for each case.
 */
export type ReadResult =
  | { kind: "absent" }
  | { kind: "ok"; state: TabsState; cleanQuit: boolean }
  | {
      kind: "recovered";
      state: TabsState;
      reason: "corrupt" | "future-version" | "migration-failed";
    }
  | { kind: "missing-active-tab"; state: TabsState };

/** Read + parse + migrate. Quarantines on corruption. */
export function readPersistedTabs(): ReadResult {
  if (typeof window === "undefined") return { kind: "absent" };
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return { kind: "absent" };
  }
  if (raw === null) return { kind: "absent" };

  // 1. Parse.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    quarantine(raw);
    return {
      kind: "recovered",
      state: { tabs: [], activeTabId: "", recentlyClosed: [] }, // caller seeds Home
      reason: "corrupt",
    };
  }

  // 2. Validate version field.
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { version?: unknown }).version !== "number"
  ) {
    quarantine(raw);
    return {
      kind: "recovered",
      state: { tabs: [], activeTabId: "", recentlyClosed: [] },
      reason: "corrupt",
    };
  }

  const version = (parsed as { version: number }).version;

  // 3. Future version → quarantine and recover.
  if (version > CURRENT_VERSION) {
    quarantine(raw);
    return {
      kind: "recovered",
      state: { tabs: [], activeTabId: "", recentlyClosed: [] },
      reason: "future-version",
    };
  }

  // 4. Past version → migrate.
  let migrated: PersistedTabs | null;
  try {
    migrated = migrate(parsed as { version: number }, version);
  } catch {
    quarantine(raw);
    return {
      kind: "recovered",
      state: { tabs: [], activeTabId: "", recentlyClosed: [] },
      reason: "migration-failed",
    };
  }

  if (!migrated) {
    quarantine(raw);
    return {
      kind: "recovered",
      state: { tabs: [], activeTabId: "", recentlyClosed: [] },
      reason: "migration-failed",
    };
  }

  // 5. Validate basic invariants on the migrated record.
  if (
    !Array.isArray(migrated.tabs) ||
    migrated.tabs.length === 0 ||
    typeof migrated.activeTabId !== "string"
  ) {
    quarantine(raw);
    return {
      kind: "recovered",
      state: { tabs: [], activeTabId: "", recentlyClosed: [] },
      reason: "corrupt",
    };
  }

  const state: TabsState = {
    tabs: migrated.tabs,
    activeTabId: migrated.activeTabId,
    recentlyClosed: Array.isArray(migrated.recentlyClosed)
      ? migrated.recentlyClosed.slice(0, RECENTLY_CLOSED_MAX)
      : [],
  };

  // 6. If activeTabId doesn't resolve, repair to the first tab and
  //    flag the caller — they may want to log telemetry.
  if (!state.tabs.find((t) => t.id === state.activeTabId)) {
    return {
      kind: "missing-active-tab",
      state: { ...state, activeTabId: state.tabs[0]!.id },
    };
  }

  return { kind: "ok", state, cleanQuit: !!migrated.cleanQuit };
}

/**
 * Migration registry. Each entry maps `from -> from+1`. Returns the
 * fully-migrated v1 record. Throws on unknown shape — the caller
 * catches and quarantines.
 *
 * Stage 3 only ships v1, so the migration table is empty. Adding
 * v2 means writing `migrate_1_to_2` and registering it here; the
 * loop below applies them in order.
 */
const MIGRATIONS: Record<number, (raw: unknown) => unknown> = {
  // 1: (raw) => migrate_1_to_2(raw),
};

function migrate(parsed: { version: number }, fromVersion: number): PersistedTabs | null {
  let cur: unknown = parsed;
  for (let v = fromVersion; v < CURRENT_VERSION; v++) {
    const fn = MIGRATIONS[v];
    if (!fn) return null;
    cur = fn(cur);
  }
  // After all migrations cur should be a v=CURRENT_VERSION record.
  if (
    !cur ||
    typeof cur !== "object" ||
    (cur as { version?: number }).version !== CURRENT_VERSION
  ) {
    // Allow records that were created at the current version to
    // pass through without an explicit version bump.
    if (
      cur &&
      typeof cur === "object" &&
      typeof (cur as { tabs?: unknown }).tabs === "object"
    ) {
      return { ...(cur as PersistedTabs), version: CURRENT_VERSION };
    }
    return null;
  }
  return cur as PersistedTabs;
}

/**
 * Write the state. Returns the outcome so callers can render a
 * "saving rejected" indicator (PRD §4.5).
 *
 * - Drops `recentlyClosed` first if the blob exceeds the soft cap.
 * - Skips the write entirely (returns "rejected") if it still
 *   exceeds the hard cap; the caller surfaces the rejection.
 * - Suppresses thrown QuotaExceededErrors so the app keeps running
 *   even with a full localStorage.
 */
export type WriteResult =
  | { kind: "ok"; bytes: number }
  | { kind: "trimmed"; bytes: number }
  | { kind: "rejected"; bytes: number }
  | { kind: "noop" };

export function writePersistedTabs(
  state: TabsState,
  options: { cleanQuit?: boolean } = {},
): WriteResult {
  if (typeof window === "undefined") return { kind: "noop" };
  const cleanQuit = !!options.cleanQuit;

  const full: PersistedTabs = {
    version: CURRENT_VERSION,
    tabs: state.tabs,
    activeTabId: state.activeTabId,
    recentlyClosed: state.recentlyClosed,
    cleanQuit,
  };
  let serialized = JSON.stringify(full);
  let trimmed = false;
  if (serialized.length > SIZE_TARGET_BYTES) {
    // First trim: drop recentlyClosed.
    const trimmedFull: PersistedTabs = { ...full, recentlyClosed: [] };
    serialized = JSON.stringify(trimmedFull);
    trimmed = true;
  }
  if (serialized.length > SIZE_HARD_LIMIT_BYTES) {
    return { kind: "rejected", bytes: serialized.length };
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, serialized);
    return {
      kind: trimmed ? "trimmed" : "ok",
      bytes: serialized.length,
    };
  } catch {
    return { kind: "rejected", bytes: serialized.length };
  }
}

/** Move a corrupt or future-version raw blob into the quarantine
 *  slot for diagnostics. Stamps the timestamp so the cleanup pass
 *  (PRD §4.5) can prune old entries. */
function quarantine(raw: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(QUARANTINE_KEY, raw);
    window.localStorage.setItem(QUARANTINE_TS_KEY, new Date().toISOString());
  } catch {
    // Best-effort; failure here is not actionable.
  }
}

/** Move the persisted blob to the crash-snapshot slot when the user
 *  picks "Start with Home" instead of restoring (PRD §4.5). The
 *  blob can be manually recovered from devtools if the user
 *  changes their mind. */
export function snapshotForCrashRecovery(): void {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return;
    window.localStorage.setItem(CRASH_SNAPSHOT_KEY, raw);
    window.localStorage.setItem(
      CRASH_SNAPSHOT_TS_KEY,
      new Date().toISOString(),
    );
  } catch {
    /* best-effort */
  }
}

/** Prune diagnostic blobs older than QUARANTINE_TTL_MS. Run at
 *  clean-quit time so accumulation is bounded. */
export function pruneOldDiagnostics(now: number = Date.now()): void {
  if (typeof window === "undefined") return;
  for (const [tsKey, blobKey] of [
    [QUARANTINE_TS_KEY, QUARANTINE_KEY],
    [CRASH_SNAPSHOT_TS_KEY, CRASH_SNAPSHOT_KEY],
  ] as const) {
    try {
      const ts = window.localStorage.getItem(tsKey);
      if (!ts) continue;
      const t = Date.parse(ts);
      if (Number.isNaN(t)) continue;
      if (now - t > QUARANTINE_TTL_MS) {
        window.localStorage.removeItem(tsKey);
        window.localStorage.removeItem(blobKey);
      }
    } catch {
      /* ignore */
    }
  }
}

/** Wipe the persisted state (Settings → Advanced → "Clear diagnostic
 *  snapshots" or test cleanup). */
export function clearPersistedTabs(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
    window.localStorage.removeItem(QUARANTINE_KEY);
    window.localStorage.removeItem(QUARANTINE_TS_KEY);
    window.localStorage.removeItem(CRASH_SNAPSHOT_KEY);
    window.localStorage.removeItem(CRASH_SNAPSHOT_TS_KEY);
  } catch {
    /* ignore */
  }
}

/** Read the user's "Restore tabs on launch" preference (PRD §4.5).
 *  Default: on. */
export const RESTORE_ON_LAUNCH_KEY = "cos.tabs.restore-on-launch.v1";

export function restoreOnLaunch(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(RESTORE_ON_LAUNCH_KEY);
    if (raw === null) return true;
    return raw !== "false";
  } catch {
    return true;
  }
}

export function setRestoreOnLaunch(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RESTORE_ON_LAUNCH_KEY, enabled ? "true" : "false");
  } catch {
    /* private mode — best-effort */
  }
}
