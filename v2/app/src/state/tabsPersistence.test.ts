/**
 * tabsPersistence tests (PRD-v2-117 §4.5).
 *
 * Covers the round-trip happy path, version validation, corrupt-blob
 * quarantine, the cleanQuit marker, the size budget (criterion #18),
 * and quarantine TTL.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RECENTLY_CLOSED_MAX,
  createTab,
  initialTabsState,
  type TabsState,
} from "./tabs";
import {
  CRASH_SNAPSHOT_KEY,
  CRASH_SNAPSHOT_TS_KEY,
  QUARANTINE_KEY,
  QUARANTINE_TS_KEY,
  QUARANTINE_TTL_MS,
  SIZE_HARD_LIMIT_BYTES,
  SIZE_TARGET_BYTES,
  STORAGE_KEY,
  clearPersistedTabs,
  pruneOldDiagnostics,
  readPersistedTabs,
  restoreOnLaunch,
  setRestoreOnLaunch,
  snapshotForCrashRecovery,
  writePersistedTabs,
} from "./tabsPersistence";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("readPersistedTabs", () => {
  it('returns "absent" when no blob is stored', () => {
    expect(readPersistedTabs().kind).toBe("absent");
  });

  it("round-trips a clean state", () => {
    const s = initialTabsState();
    writePersistedTabs(s, { cleanQuit: true });
    const r = readPersistedTabs();
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.cleanQuit).toBe(true);
    expect(r.state.tabs).toHaveLength(1);
    expect(r.state.activeTabId).toBe(s.tabs[0]!.id);
  });

  it('marks the read as crash-recovery candidate when cleanQuit was false', () => {
    writePersistedTabs(initialTabsState(), { cleanQuit: false });
    const r = readPersistedTabs();
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.cleanQuit).toBe(false);
  });

  it('quarantines a non-JSON blob and returns "recovered: corrupt"', () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    const r = readPersistedTabs();
    expect(r.kind).toBe("recovered");
    if (r.kind !== "recovered") return;
    expect(r.reason).toBe("corrupt");
    expect(window.localStorage.getItem(QUARANTINE_KEY)).toBe("{not json");
    expect(window.localStorage.getItem(QUARANTINE_TS_KEY)).not.toBeNull();
  });

  it("quarantines a future-version blob and returns recovered", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 99, tabs: [], activeTabId: "" }),
    );
    const r = readPersistedTabs();
    expect(r.kind).toBe("recovered");
    if (r.kind !== "recovered") return;
    expect(r.reason).toBe("future-version");
    expect(window.localStorage.getItem(QUARANTINE_KEY)).not.toBeNull();
  });

  it("quarantines a blob without a numeric version", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ tabs: [], activeTabId: "" }),
    );
    const r = readPersistedTabs();
    expect(r.kind).toBe("recovered");
  });

  it("repairs a missing-active-tab record by focusing the first tab", () => {
    const s = initialTabsState();
    const broken = JSON.stringify({
      version: 1,
      tabs: s.tabs,
      activeTabId: "ghost",
      recentlyClosed: [],
      cleanQuit: true,
    });
    window.localStorage.setItem(STORAGE_KEY, broken);
    const r = readPersistedTabs();
    expect(r.kind).toBe("missing-active-tab");
    if (r.kind !== "missing-active-tab") return;
    expect(r.state.activeTabId).toBe(s.tabs[0]!.id);
  });
});

describe("writePersistedTabs size budget (criterion #18)", () => {
  function bigState(n: number): TabsState {
    const tabs = Array.from({ length: n }, (_, i) =>
      createTab("people", {
        peopleProfile: {
          slug: `slug-${i}`,
          label: `Person ${i}`,
          rel_path: `areas/one-on-ones/direct-reports/person-${i}`,
        },
        userTitle: "x".repeat(40),
      }),
    );
    return { tabs, activeTabId: tabs[0]!.id, recentlyClosed: [] };
  }

  it("at 30 tabs the serialized blob stays under 256KB", () => {
    const r = writePersistedTabs(bigState(30));
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.bytes).toBeLessThan(SIZE_TARGET_BYTES);
  });

  it("trims recentlyClosed first when over the soft cap", () => {
    // Build a state where the recentlyClosed ring alone would push
    // past the cap.
    const tabs = bigState(20);
    const fakeClosed = Array.from({ length: RECENTLY_CLOSED_MAX }, () => ({
      state: createTab("home", {
        userTitle: "x".repeat(SIZE_TARGET_BYTES / RECENTLY_CLOSED_MAX),
      }),
      closedAt: new Date().toISOString(),
    }));
    const oversized: TabsState = { ...tabs, recentlyClosed: fakeClosed };
    const r = writePersistedTabs(oversized);
    expect(r.kind).toBe("trimmed");
    // After trim, the persisted blob should be under the soft cap.
    if (r.kind === "trimmed") expect(r.bytes).toBeLessThan(SIZE_TARGET_BYTES);
    // What landed in storage has no recentlyClosed entries.
    const back = readPersistedTabs();
    if (back.kind !== "ok") throw new Error("expected ok after trim");
    expect(back.state.recentlyClosed).toHaveLength(0);
  });

  it("rejects writes that exceed the hard cap even after trim", () => {
    // userTitle over 1MB pushes the tab itself past the hard limit.
    const monster = createTab("home", {
      userTitle: "x".repeat(SIZE_HARD_LIMIT_BYTES + 1),
    });
    const oversized: TabsState = {
      tabs: [monster],
      activeTabId: monster.id,
      recentlyClosed: [],
    };
    const r = writePersistedTabs(oversized);
    expect(r.kind).toBe("rejected");
  });
});

describe("snapshot + prune", () => {
  it("snapshotForCrashRecovery copies the blob to the crash-snapshot key", () => {
    writePersistedTabs(initialTabsState(), { cleanQuit: true });
    snapshotForCrashRecovery();
    expect(window.localStorage.getItem(CRASH_SNAPSHOT_KEY)).not.toBeNull();
    expect(window.localStorage.getItem(CRASH_SNAPSHOT_TS_KEY)).not.toBeNull();
  });

  it("pruneOldDiagnostics deletes blobs older than the TTL and keeps fresh ones", () => {
    // Old quarantine: TTL+1ms ago.
    window.localStorage.setItem(QUARANTINE_KEY, "old");
    window.localStorage.setItem(
      QUARANTINE_TS_KEY,
      new Date(Date.now() - QUARANTINE_TTL_MS - 1000).toISOString(),
    );
    // Fresh crash snapshot: now.
    window.localStorage.setItem(CRASH_SNAPSHOT_KEY, "fresh");
    window.localStorage.setItem(
      CRASH_SNAPSHOT_TS_KEY,
      new Date().toISOString(),
    );
    pruneOldDiagnostics();
    expect(window.localStorage.getItem(QUARANTINE_KEY)).toBeNull();
    expect(window.localStorage.getItem(CRASH_SNAPSHOT_KEY)).toBe("fresh");
  });
});

describe("restoreOnLaunch toggle", () => {
  it("defaults to true", () => {
    expect(restoreOnLaunch()).toBe(true);
  });

  it("respects an explicit false", () => {
    setRestoreOnLaunch(false);
    expect(restoreOnLaunch()).toBe(false);
    setRestoreOnLaunch(true);
    expect(restoreOnLaunch()).toBe(true);
  });
});

describe("clearPersistedTabs", () => {
  it("removes every persistence key", () => {
    writePersistedTabs(initialTabsState(), { cleanQuit: true });
    snapshotForCrashRecovery();
    window.localStorage.setItem(QUARANTINE_KEY, "x");
    window.localStorage.setItem(QUARANTINE_TS_KEY, "x");
    clearPersistedTabs();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(QUARANTINE_KEY)).toBeNull();
    expect(window.localStorage.getItem(QUARANTINE_TS_KEY)).toBeNull();
    expect(window.localStorage.getItem(CRASH_SNAPSHOT_KEY)).toBeNull();
    expect(window.localStorage.getItem(CRASH_SNAPSHOT_TS_KEY)).toBeNull();
  });
});
