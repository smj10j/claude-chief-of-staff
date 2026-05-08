// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearRecent,
  DEFAULT_SIDEBAR_RECENTS_MAX,
  decorateRecentLabel,
  isPinned,
  RECENT_CHANGED_EVENT,
  RECENT_MAX,
  readRecent,
  readSidebarRecentsMax,
  recordRecent,
  SIDEBAR_RECENTS_MAX_OPTIONS,
  togglePinned,
  writeSidebarRecentsMax,
} from "./recentDocs";

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) ?? null) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

beforeEach(() => {
  // vitest jsdom env exposes window — fresh storage per test.
  (window as unknown as { localStorage: MemoryStorage }).localStorage =
    new MemoryStorage();
});

describe("recentDocs", () => {
  it("returns empty when storage is unset", () => {
    expect(readRecent()).toEqual([]);
  });

  it("recordRecent prepends, dedupes by relPath", () => {
    recordRecent("a/x.md", "X");
    recordRecent("a/y.md", "Y");
    recordRecent("a/x.md", "X (re-opened)");
    const list = readRecent();
    expect(list.map((d) => d.relPath)).toEqual(["a/x.md", "a/y.md"]);
    expect(list[0].label).toBe("X (re-opened)");
  });

  it("trims to RECENT_MAX", () => {
    for (let i = 0; i < RECENT_MAX + 5; i++) {
      recordRecent(`a/${i}.md`, `D${i}`);
    }
    const list = readRecent();
    expect(list.length).toBe(RECENT_MAX);
    // Most recent first.
    expect(list[0].relPath).toBe(`a/${RECENT_MAX + 4}.md`);
  });

  it("ignores empty relPath", () => {
    recordRecent("", "blank");
    expect(readRecent()).toEqual([]);
  });

  it("fires the change event on record", () => {
    const handler = vi.fn();
    window.addEventListener(RECENT_CHANGED_EVENT, handler);
    recordRecent("a/x.md", "X");
    expect(handler).toHaveBeenCalledTimes(1);
    window.removeEventListener(RECENT_CHANGED_EVENT, handler);
  });

  it("clearRecent empties the list", () => {
    recordRecent("a/x.md", "X");
    expect(readRecent()).toHaveLength(1);
    clearRecent();
    expect(readRecent()).toEqual([]);
  });

  it("survives malformed stored JSON", () => {
    window.localStorage.setItem(
      "cos.recent-docs.v1",
      "not json at all",
    );
    expect(readRecent()).toEqual([]);
  });

  it("togglePinned flips pin state and persists separately", () => {
    recordRecent("a/x.md", "X");
    expect(isPinned("a/x.md")).toBe(false);
    expect(togglePinned("a/x.md")).toBe(true);
    expect(isPinned("a/x.md")).toBe(true);
    // readRecent reflects pinned state.
    expect(readRecent()[0].pinned).toBe(true);
    // Toggle again → unpinned.
    expect(togglePinned("a/x.md")).toBe(false);
    expect(isPinned("a/x.md")).toBe(false);
  });

  it("pinned docs survive the RECENT_MAX trim (B7-CP25)", () => {
    // Pin a known doc, then push enough new docs to overflow the cap.
    recordRecent("a/keep-me.md", "Keep Me");
    togglePinned("a/keep-me.md");
    for (let i = 0; i < RECENT_MAX + 10; i++) {
      recordRecent(`a/${i}.md`, `D${i}`);
    }
    const list = readRecent();
    const found = list.find((d) => d.relPath === "a/keep-me.md");
    expect(found).toBeDefined();
    expect(found?.pinned).toBe(true);
  });

  it("unpinning a pinned-but-trim-eligible doc lets it drop on next record", () => {
    togglePinned("a/keep.md"); // pin first (pinned set is persisted
    // independently — pinning before recording is fine).
    recordRecent("a/keep.md", "Keep");
    // Push past the cap.
    for (let i = 0; i < RECENT_MAX + 5; i++) {
      recordRecent(`a/${i}.md`, `D${i}`);
    }
    expect(readRecent().some((d) => d.relPath === "a/keep.md")).toBe(true);
    togglePinned("a/keep.md"); // unpin
    // Trim happens on the next record.
    recordRecent("a/zzz.md", "ZZZ");
    expect(readRecent().some((d) => d.relPath === "a/keep.md")).toBe(false);
  });

  it("readSidebarRecentsMax defaults to 5 and round-trips legal values", () => {
    expect(readSidebarRecentsMax()).toBe(DEFAULT_SIDEBAR_RECENTS_MAX);
    for (const n of SIDEBAR_RECENTS_MAX_OPTIONS) {
      writeSidebarRecentsMax(n);
      expect(readSidebarRecentsMax()).toBe(n);
    }
  });

  it("readSidebarRecentsMax falls back to default for illegal stored values", () => {
    window.localStorage.setItem("cos.sidebar-recents-max.v1", "42");
    expect(readSidebarRecentsMax()).toBe(DEFAULT_SIDEBAR_RECENTS_MAX);
    window.localStorage.setItem("cos.sidebar-recents-max.v1", "abc");
    expect(readSidebarRecentsMax()).toBe(DEFAULT_SIDEBAR_RECENTS_MAX);
  });

  it("writeSidebarRecentsMax fires the recents-changed event so the sidebar live-updates", () => {
    const handler = vi.fn();
    window.addEventListener(RECENT_CHANGED_EVENT, handler);
    writeSidebarRecentsMax(15);
    expect(handler).toHaveBeenCalled();
    window.removeEventListener(RECENT_CHANGED_EVENT, handler);
  });

  it("RECENT_MAX matches the largest sidebar option (no underflow)", () => {
    const largest = Math.max(
      ...(SIDEBAR_RECENTS_MAX_OPTIONS as readonly number[]),
    );
    expect(RECENT_MAX).toBeGreaterThanOrEqual(largest);
  });

  it("filters out malformed entries during read", () => {
    window.localStorage.setItem(
      "cos.recent-docs.v1",
      JSON.stringify([
        { relPath: "good.md", label: "Good", openedAt: 1 },
        { relPath: "", label: "blank" },
        { relPath: "no-label.md" },
        "string entry",
        null,
      ]),
    );
    const list = readRecent();
    expect(list).toEqual([
      { relPath: "good.md", label: "Good", openedAt: 1 },
    ]);
  });
});

describe("decorateRecentLabel", () => {
  it("leaves a specific label unchanged", () => {
    expect(
      decorateRecentLabel(
        "areas/one-on-ones/peers/aaron/README.md",
        "Aaron's Notes",
      ),
    ).toBe("Aaron's Notes");
  });

  it("prefixes the parent person for a generic README label", () => {
    expect(
      decorateRecentLabel(
        "areas/one-on-ones/manager/bob/README.md",
        "README",
      ),
    ).toBe("Bob · README");
  });

  it("prefixes the parent person for a date-shaped session label", () => {
    expect(
      decorateRecentLabel(
        "areas/one-on-ones/direct-reports/alice/sessions/2026-04-25.md",
        "2026-04-25",
      ),
    ).toBe("Alice · 2026-04-25");
  });

  it("humanizes hyphenated slugs (team-eng-leads → Team Eng Leads)", () => {
    expect(
      decorateRecentLabel(
        "areas/meetings/team-eng-leads/sessions/2026-03-10.md",
        "2026-03-10",
      ),
    ).toBe("Team Eng Leads · 2026-03-10");
  });

  it("prefixes the parent project for a generic README label", () => {
    expect(
      decorateRecentLabel("projects/director-pm-backfill/README.md", "README"),
    ).toBe("Director Pm Backfill · README");
  });

  it("returns just the owner when the label is empty", () => {
    expect(
      decorateRecentLabel("projects/q3-launch/README.md", ""),
    ).toBe("Q3 Launch");
  });

  it("falls back to the label when no owner segment can be found", () => {
    // "data" + "files" are skipped; nothing else is present.
    expect(decorateRecentLabel("data/files/loose.md", "loose")).toBe("loose");
  });

  it("treats 'index' the same as 'README'", () => {
    expect(
      decorateRecentLabel("projects/alpha/index.md", "index"),
    ).toBe("Alpha · index");
  });

  it("is case-insensitive on the generic-label match", () => {
    expect(
      decorateRecentLabel("projects/alpha/README.md", "Readme"),
    ).toBe("Alpha · Readme");
  });
});
