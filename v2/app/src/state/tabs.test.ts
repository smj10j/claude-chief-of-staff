import { describe, expect, it } from "vitest";

import {
  NAV_HISTORY_MAX,
  RECENTLY_CLOSED_MAX,
  activeTab,
  appendTab,
  canGoBack,
  canGoForward,
  closeOtherTabs,
  closeTab,
  closeTabsToTheRight,
  createTab,
  deriveTitle,
  duplicateTab,
  goBack,
  goForward,
  initialTabsState,
  intentFromEvent,
  moveTab,
  nextTab,
  pinTab,
  prevTab,
  renameTab,
  reopenLastClosedTab,
  setTabsEnabled,
  switchTab,
  switchToTabByIndex,
  tabHasRunningSkill,
  tabsEnabled,
  unpinTab,
  updateActiveTab,
  type TabState,
  type TabsState,
} from "./tabs";

function withTwoTabs(): TabsState {
  const a = createTab("home");
  const b = createTab("work");
  return { tabs: [a, b], activeTabId: a.id, recentlyClosed: [] };
}

describe("createTab", () => {
  it("defaults to a Home tab with empty selection", () => {
    const t = createTab();
    expect(t.surface).toBe("home");
    expect(t.peopleProfile).toBeNull();
    expect(t.projectProfile).toBeNull();
    expect(t.meetingProfile).toBeNull();
    expect(t.openDoc).toBeNull();
    expect(t.selectedTask).toBeNull();
    expect(t.sideOpen).toBe(false);
    expect(t.taskScrollHint).toBeNull();
  });

  it("respects an explicit surface", () => {
    expect(createTab("work").surface).toBe("work");
    expect(createTab("people").surface).toBe("people");
  });

  it("applies overrides on top of defaults", () => {
    const t = createTab("work", {
      sideOpen: true,
      userTitle: "Q3 prep",
      pinned: true,
    });
    expect(t.sideOpen).toBe(true);
    expect(t.userTitle).toBe("Q3 prep");
    expect(t.pinned).toBe(true);
    expect(t.surface).toBe("work");
  });

  it("stamps createdAt and lastActiveAt with parseable ISO timestamps", () => {
    const t = createTab();
    expect(() => new Date(t.createdAt).toISOString()).not.toThrow();
    expect(() => new Date(t.lastActiveAt).toISOString()).not.toThrow();
  });

  it("assigns unique ids to distinct tabs", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) ids.add(createTab().id);
    expect(ids.size).toBe(50);
  });
});

describe("initialTabsState", () => {
  it("starts with a single Home tab whose id is the active id", () => {
    const s = initialTabsState();
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0]!.surface).toBe("home");
    expect(s.activeTabId).toBe(s.tabs[0]!.id);
  });
});

describe("activeTab", () => {
  it("returns the tab matching activeTabId", () => {
    const s = withTwoTabs();
    expect(activeTab(s).id).toBe(s.tabs[0]!.id);
    const switched: TabsState = { ...s, activeTabId: s.tabs[1]!.id };
    expect(activeTab(switched).id).toBe(s.tabs[1]!.id);
  });

  it("throws when activeTabId resolves to nothing — that's a bug, not a soft failure", () => {
    const s: TabsState = {
      tabs: [createTab("home")],
      activeTabId: "does-not-exist",
      recentlyClosed: [],
    };
    expect(() => activeTab(s)).toThrow(/tabs invariant/);
  });
});

describe("updateActiveTab", () => {
  it("applies a partial patch to the active tab", () => {
    const s = withTwoTabs();
    const next = updateActiveTab(s, () => ({ surface: "people" }));
    expect(activeTab(next).surface).toBe("people");
    // Sibling tab unchanged.
    expect(next.tabs[1]!.surface).toBe("work");
  });

  it("returns a new TabsState (immutable update)", () => {
    const s = withTwoTabs();
    const next = updateActiveTab(s, () => ({ sideOpen: true }));
    expect(next).not.toBe(s);
    expect(next.tabs).not.toBe(s.tabs);
    expect(next.tabs[0]).not.toBe(s.tabs[0]);
    // The non-active tab keeps reference identity.
    expect(next.tabs[1]).toBe(s.tabs[1]);
  });

  it("can clear nullable fields", () => {
    const s = withTwoTabs();
    const withDoc = updateActiveTab(s, () => ({
      openDoc: { relPath: "x.md", label: "x" },
    }));
    expect(activeTab(withDoc).openDoc?.relPath).toBe("x.md");
    const cleared = updateActiveTab(withDoc, () => ({ openDoc: null }));
    expect(activeTab(cleared).openDoc).toBeNull();
  });

  it("preserves other fields when patching just one", () => {
    const s = withTwoTabs();
    const seeded = updateActiveTab(s, () => ({
      sideOpen: true,
      selectedTask: { id: "t1" } as TabState["selectedTask"],
    }));
    const after = updateActiveTab(seeded, () => ({ surface: "people" }));
    expect(activeTab(after).surface).toBe("people");
    expect(activeTab(after).sideOpen).toBe(true);
    expect(activeTab(after).selectedTask?.id).toBe("t1");
  });

  it("only touches the active tab", () => {
    const s = withTwoTabs();
    const next = updateActiveTab(s, () => ({ surface: "people" }));
    expect(next.tabs[1]!.surface).toBe("work");
    // Switch active and patch — the previously-active tab should
    // now hold its old value.
    const switched: TabsState = { ...next, activeTabId: next.tabs[1]!.id };
    const patched = updateActiveTab(switched, () => ({ surface: "ops" }));
    expect(patched.tabs[0]!.surface).toBe("people");
    expect(patched.tabs[1]!.surface).toBe("ops");
  });
});

describe("appendTab", () => {
  it("pushes onto the end and keeps activeTabId when activate=false (background open)", () => {
    const s = withTwoTabs();
    const newTab = createTab("ops");
    const after = appendTab(s, newTab, false);
    expect(after.tabs.map((t) => t.id)).toEqual([
      s.tabs[0]!.id,
      s.tabs[1]!.id,
      newTab.id,
    ]);
    expect(after.activeTabId).toBe(s.activeTabId);
  });

  it("activates the new tab when activate=true (foreground open)", () => {
    const s = withTwoTabs();
    const newTab = createTab("ops");
    const after = appendTab(s, newTab, true);
    expect(after.activeTabId).toBe(newTab.id);
  });
});

describe("closeTab", () => {
  it("returns input unchanged when the id isn't found", () => {
    const s = withTwoTabs();
    expect(closeTab(s, "missing")).toBe(s);
  });

  it("last-tab guard: replaces the only tab with a fresh Home tab", () => {
    const s = initialTabsState();
    const after = closeTab(s, s.activeTabId);
    expect(after.tabs).toHaveLength(1);
    expect(after.tabs[0]!.surface).toBe("home");
    // It's a *new* tab, not the same reference.
    expect(after.tabs[0]!.id).not.toBe(s.tabs[0]!.id);
    expect(after.activeTabId).toBe(after.tabs[0]!.id);
  });

  it("closing the active middle tab focuses its right neighbor", () => {
    const a = createTab("home");
    const b = createTab("work");
    const c = createTab("ops");
    const s: TabsState = { tabs: [a, b, c], activeTabId: b.id, recentlyClosed: [] };
    const after = closeTab(s, b.id);
    expect(after.tabs.map((t) => t.id)).toEqual([a.id, c.id]);
    expect(after.activeTabId).toBe(c.id);
  });

  it("closing the active rightmost tab focuses the new rightmost (left neighbor)", () => {
    const a = createTab("home");
    const b = createTab("work");
    const s: TabsState = { tabs: [a, b], activeTabId: b.id, recentlyClosed: [] };
    const after = closeTab(s, b.id);
    expect(after.tabs.map((t) => t.id)).toEqual([a.id]);
    expect(after.activeTabId).toBe(a.id);
  });

  it("closing an inactive tab does not change activeTabId", () => {
    const a = createTab("home");
    const b = createTab("work");
    const s: TabsState = { tabs: [a, b], activeTabId: a.id, recentlyClosed: [] };
    const after = closeTab(s, b.id);
    expect(after.activeTabId).toBe(a.id);
  });
});

describe("moveTab (drag-reorder, PRD §4.2 / criterion #12)", () => {
  function fourTabs(): TabsState {
    const a = createTab("home");
    const b = createTab("work");
    const c = createTab("ops");
    const d = createTab("settings");
    return { tabs: [a, b, c, d], activeTabId: a.id, recentlyClosed: [] };
  }

  it("moves a tab forward in the strip", () => {
    const s = fourTabs();
    // Drag tab 0 to position 3 — it lands at index 2 after splice.
    const after = moveTab(s, 0, 3);
    expect(after.tabs.map((t) => t.id)).toEqual([
      s.tabs[1]!.id,
      s.tabs[2]!.id,
      s.tabs[0]!.id,
      s.tabs[3]!.id,
    ]);
  });

  it("moves a tab backward in the strip", () => {
    const s = fourTabs();
    const after = moveTab(s, 3, 1);
    expect(after.tabs.map((t) => t.id)).toEqual([
      s.tabs[0]!.id,
      s.tabs[3]!.id,
      s.tabs[1]!.id,
      s.tabs[2]!.id,
    ]);
  });

  it("no-op when dropping in the same slot or immediately after the source", () => {
    const s = fourTabs();
    expect(moveTab(s, 1, 1)).toBe(s);
    expect(moveTab(s, 1, 2)).toBe(s);
  });

  it("clamps a pinned tab so it can't cross into the unpinned region", () => {
    let s = fourTabs();
    s = pinTab(s, s.tabs[0]!.id); // [0-pinned, 1, 2, 3]
    // Try to drag the pinned tab to index 3 (deep in unpinned).
    const after = moveTab(s, 0, 3);
    // It clamps to the boundary (pinnedCount === 1) → no-op
    // because the clamped target equals the source position+1.
    expect(after).toBe(s);
  });

  it("clamps an unpinned tab so it can't cross into the pinned region", () => {
    let s = fourTabs();
    s = pinTab(s, s.tabs[0]!.id); // [0-pinned, 1, 2, 3]
    const before = s.tabs.map((t) => t.id);
    // Drag tab at index 2 to position 0 — would put it left of the
    // pin; the move clamps to pinnedCount=1, so the unpinned tab
    // lands at index 1.
    const after = moveTab(s, 2, 0);
    expect(after.tabs[0]!.pinned).toBe(true);
    expect(after.tabs[0]!.id).toBe(before[0]);
    // The dragged tab (original index 2) is now at index 1.
    expect(after.tabs[1]!.id).toBe(before[2]);
  });

  it("returns input unchanged for invalid indices", () => {
    const s = fourTabs();
    expect(moveTab(s, -1, 2)).toBe(s);
    expect(moveTab(s, 99, 0)).toBe(s);
    expect(moveTab(s, 0, -1)).toBe(s);
    expect(moveTab(s, 0, 99)).toBe(s);
  });
});

describe("pinTab / unpinTab (PRD §4.2 — sticky-left)", () => {
  it("pinning moves the tab to the right end of the (initially empty) pinned region", () => {
    const a = createTab("home");
    const b = createTab("work");
    const c = createTab("ops");
    const s: TabsState = { tabs: [a, b, c], activeTabId: a.id, recentlyClosed: [] };
    const after = pinTab(s, c.id);
    expect(after.tabs.map((t) => t.id)).toEqual([c.id, a.id, b.id]);
    expect(after.tabs[0]!.pinned).toBe(true);
  });

  it("pinning a second tab places it after existing pins", () => {
    let s: TabsState = withTwoTabs();
    const c = createTab("ops");
    s = appendTab(s, c, false);
    s = pinTab(s, s.tabs[0]!.id);
    s = pinTab(s, c.id);
    expect(s.tabs[0]!.pinned).toBe(true);
    expect(s.tabs[1]!.pinned).toBe(true);
    expect(s.tabs[2]!.pinned).toBeFalsy();
    expect(s.tabs[1]!.id).toBe(c.id);
  });

  it("unpinning moves the tab to the left end of the unpinned region", () => {
    let s: TabsState = withTwoTabs();
    const c = createTab("ops");
    s = appendTab(s, c, false);
    s = pinTab(s, c.id); // [c-pinned, a, b]
    s = unpinTab(s, c.id);
    expect(s.tabs[0]!.pinned).toBe(false);
    expect(s.tabs[0]!.id).toBe(c.id);
  });

  it("pin and unpin are idempotent on no-op cases", () => {
    const s = withTwoTabs();
    expect(pinTab(s, "missing")).toBe(s);
    expect(unpinTab(s, "missing")).toBe(s);
    const pinned = pinTab(s, s.tabs[0]!.id);
    expect(pinTab(pinned, s.tabs[0]!.id)).toBe(pinned);
    expect(unpinTab(s, s.tabs[0]!.id)).toBe(s);
  });
});

describe("renameTab", () => {
  it("sets userTitle and trims whitespace", () => {
    const s = withTwoTabs();
    const after = renameTab(s, s.tabs[0]!.id, "  Q3 prep  ");
    expect(after.tabs[0]!.userTitle).toBe("Q3 prep");
  });

  it("empty submission clears the rename (PRD §4.3 reset to auto)", () => {
    let s = withTwoTabs();
    s = renameTab(s, s.tabs[0]!.id, "Q3");
    s = renameTab(s, s.tabs[0]!.id, "");
    expect(s.tabs[0]!.userTitle).toBeUndefined();
  });

  it("only touches the named tab", () => {
    const s = withTwoTabs();
    const after = renameTab(s, s.tabs[0]!.id, "Renamed");
    expect(after.tabs[1]!.userTitle).toBeUndefined();
  });
});

describe("duplicateTab", () => {
  it("inserts a fresh-id copy to the right of the source", () => {
    const a = createTab("home");
    const b = createTab("people", {
      peopleProfile: { slug: "x", label: "Alice", rel_path: "x" },
    });
    const s: TabsState = { tabs: [a, b], activeTabId: a.id, recentlyClosed: [] };
    const after = duplicateTab(s, b.id);
    expect(after.tabs).toHaveLength(3);
    expect(after.tabs[2]!.id).not.toBe(b.id);
    expect(after.tabs[2]!.peopleProfile?.label).toBe("Alice");
  });

  it("duplicating a pinned tab produces an unpinned copy (Chrome convention)", () => {
    const a = createTab("home");
    const pinned = createTab("work");
    let s: TabsState = { tabs: [a, pinned], activeTabId: a.id, recentlyClosed: [] };
    s = pinTab(s, pinned.id);
    s = duplicateTab(s, pinned.id);
    // Order: [pinned, a, dup-of-pinned-but-unpinned]
    const dup = s.tabs[s.tabs.length - 1]!;
    expect(dup.pinned).toBeUndefined();
  });
});

describe("closeOtherTabs / closeTabsToTheRight", () => {
  it('"close other tabs" closes every unpinned non-anchor; pinned tabs are spared', () => {
    const a = createTab("home");
    const b = createTab("work");
    const c = createTab("ops");
    const d = createTab("settings");
    let s: TabsState = { tabs: [a, b, c, d], activeTabId: c.id, recentlyClosed: [] };
    s = pinTab(s, a.id); // a is pinned, leftmost
    const after = closeOtherTabs(s, c.id);
    // [a-pinned, c-anchor]
    expect(after.tabs.map((t) => t.id)).toEqual([a.id, c.id]);
    expect(after.activeTabId).toBe(c.id);
  });

  it('"close tabs to the right" closes only unpinned tabs to the right of the anchor', () => {
    const a = createTab("home");
    const b = createTab("work");
    const c = createTab("ops");
    const d = createTab("settings");
    const s: TabsState = { tabs: [a, b, c, d], activeTabId: a.id, recentlyClosed: [] };
    const after = closeTabsToTheRight(s, b.id);
    expect(after.tabs.map((t) => t.id)).toEqual([a.id, b.id]);
  });

  it("close-other / close-right preserve activeTabId when the anchor is current", () => {
    const a = createTab("home");
    const b = createTab("work");
    const c = createTab("ops");
    const s: TabsState = { tabs: [a, b, c], activeTabId: b.id, recentlyClosed: [] };
    expect(closeOtherTabs(s, b.id).activeTabId).toBe(b.id);
    expect(closeTabsToTheRight(s, b.id).activeTabId).toBe(b.id);
  });
});

describe("tabHasRunningSkill (PRD §4.7 / criterion #14)", () => {
  const alice = createTab("people", {
    peopleProfile: { slug: "alice", label: "Alice", rel_path: "x" },
  });
  const project = createTab("projects", {
    projectProfile: { slug: "bank-q", label: "Bank Q", rel_path: "x" },
  });
  const home = createTab("home");

  it("matches a person-targeted run by slug", () => {
    expect(
      tabHasRunningSkill(alice, [
        { id: "prep-1on1:alice", state: "running" },
      ]),
    ).toBe(true);
  });

  it("matches a doc-targeted run by relPath", () => {
    const t = createTab("people", {
      openDoc: {
        relPath: "areas/one-on-ones/direct-reports/alice/sessions/2026-04-22.md",
        label: "2026-04-22",
      },
    });
    expect(
      tabHasRunningSkill(t, [
        {
          id: "digest-meeting:areas/one-on-ones/direct-reports/alice/sessions/2026-04-22.md",
          state: "running",
        },
      ]),
    ).toBe(true);
  });

  it("does NOT match surface-scoped runs (no `:` in id)", () => {
    expect(
      tabHasRunningSkill(home, [{ id: "morning-briefing", state: "running" }]),
    ).toBe(false);
  });

  it("does NOT match completed/errored runs", () => {
    expect(
      tabHasRunningSkill(alice, [
        { id: "prep-1on1:alice", state: "done" },
      ]),
    ).toBe(false);
  });

  it("does not cross-match between person and project slugs", () => {
    expect(
      tabHasRunningSkill(project, [
        { id: "prep-1on1:alice", state: "running" },
      ]),
    ).toBe(false);
  });

  it("home tabs with no addressable target never light up", () => {
    expect(
      tabHasRunningSkill(home, [
        { id: "prep-1on1:alice", state: "running" },
      ]),
    ).toBe(false);
  });
});

describe("recentlyClosed ring buffer + reopenLastClosedTab", () => {
  it("closing a meaningful tab pushes onto the ring", () => {
    const a = createTab("home");
    const b = createTab("people", {
      peopleProfile: { slug: "x", label: "Alice", rel_path: "x" },
    });
    const s: TabsState = { tabs: [a, b], activeTabId: b.id, recentlyClosed: [] };
    const after = closeTab(s, b.id);
    expect(after.recentlyClosed).toHaveLength(1);
    expect(after.recentlyClosed[0]!.state.peopleProfile?.label).toBe("Alice");
  });

  it("closing an empty Home tab is filtered out (no ring entry)", () => {
    const a = createTab("home");
    const b = createTab("home"); // empty Home — meaningful state is false
    const s: TabsState = { tabs: [a, b], activeTabId: b.id, recentlyClosed: [] };
    const after = closeTab(s, b.id);
    expect(after.recentlyClosed).toHaveLength(0);
  });

  it("ring is capped at RECENTLY_CLOSED_MAX (oldest falls off)", () => {
    let s: TabsState = withTwoTabs();
    // Close many meaningful tabs by appending then closing each.
    for (let i = 0; i < RECENTLY_CLOSED_MAX + 5; i++) {
      const tab = createTab("people", {
        peopleProfile: { slug: `p${i}`, label: `Person ${i}`, rel_path: "x" },
      });
      s = { ...s, tabs: [...s.tabs, tab] };
      s = closeTab(s, tab.id);
    }
    expect(s.recentlyClosed).toHaveLength(RECENTLY_CLOSED_MAX);
    // Newest at the front: the last close (i=14) is index 0.
    expect(s.recentlyClosed[0]!.state.peopleProfile?.slug).toBe("p14");
    // Oldest still in ring is i=5 (10 entries, newest first).
    expect(s.recentlyClosed[RECENTLY_CLOSED_MAX - 1]!.state.peopleProfile?.slug).toBe(
      "p5",
    );
  });

  it("Cmd+Shift+T reopens the most recently closed tab and pops it from the ring", () => {
    const a = createTab("home");
    const b = createTab("work", { sideOpen: true });
    let s: TabsState = { tabs: [a, b], activeTabId: b.id, recentlyClosed: [] };
    s = closeTab(s, b.id);
    expect(s.tabs).toHaveLength(1);
    expect(s.recentlyClosed).toHaveLength(1);

    s = reopenLastClosedTab(s);
    expect(s.tabs).toHaveLength(2);
    // Resurrected tab carries the original surface and sideOpen
    // through, focuses, and gets a fresh id.
    const resurrected = s.tabs[1]!;
    expect(resurrected.surface).toBe("work");
    expect(resurrected.sideOpen).toBe(true);
    expect(resurrected.id).not.toBe(b.id);
    expect(s.activeTabId).toBe(resurrected.id);
    expect(s.recentlyClosed).toHaveLength(0);
  });

  it("resurrected tab preserves userTitle (PRD §4.5)", () => {
    const a = createTab("home");
    const renamed = createTab("people", {
      userTitle: "Q3 prep",
      peopleProfile: { slug: "x", label: "Alice", rel_path: "x" },
    });
    let s: TabsState = {
      tabs: [a, renamed],
      activeTabId: renamed.id,
      recentlyClosed: [],
    };
    s = closeTab(s, renamed.id);
    s = reopenLastClosedTab(s);
    expect(s.tabs[1]!.userTitle).toBe("Q3 prep");
  });

  it("reopen is a no-op when the ring is empty", () => {
    const s = initialTabsState();
    expect(reopenLastClosedTab(s)).toBe(s);
  });

  it("reopens in last-in-first-out order across multiple closes", () => {
    let s: TabsState = withTwoTabs();
    const x = createTab("people", {
      peopleProfile: { slug: "x", label: "X", rel_path: "x" },
    });
    const y = createTab("projects", {
      projectProfile: { slug: "y", label: "Y", rel_path: "y" },
    });
    const z = createTab("meetings", {
      meetingProfile: { slug: "z", label: "Z", rel_path: "z" },
    });
    s = { ...s, tabs: [...s.tabs, x, y, z] };
    s = closeTab(s, x.id); // ring: [x]
    s = closeTab(s, y.id); // ring: [y, x]
    s = closeTab(s, z.id); // ring: [z, y, x]

    s = reopenLastClosedTab(s);
    expect(s.tabs[s.tabs.length - 1]!.surface).toBe("meetings"); // z first
    s = reopenLastClosedTab(s);
    expect(s.tabs[s.tabs.length - 1]!.surface).toBe("projects"); // then y
    s = reopenLastClosedTab(s);
    expect(s.tabs[s.tabs.length - 1]!.surface).toBe("people"); // then x
    expect(s.recentlyClosed).toHaveLength(0);
  });
});

describe("switchTab", () => {
  it("no-op when the target is already active", () => {
    const s = withTwoTabs();
    expect(switchTab(s, s.activeTabId)).toBe(s);
  });

  it("no-op when the target id isn't in tabs", () => {
    const s = withTwoTabs();
    expect(switchTab(s, "missing")).toBe(s);
  });

  it("updates activeTabId and bumps lastActiveAt on the new active tab", async () => {
    const s = withTwoTabs();
    const before = s.tabs[1]!.lastActiveAt;
    // Tiny pause so the ISO timestamp can differ.
    await new Promise((r) => setTimeout(r, 5));
    const after = switchTab(s, s.tabs[1]!.id);
    expect(after.activeTabId).toBe(s.tabs[1]!.id);
    expect(after.tabs[1]!.lastActiveAt).not.toBe(before);
    // Other tab's lastActiveAt is unchanged.
    expect(after.tabs[0]!.lastActiveAt).toBe(s.tabs[0]!.lastActiveAt);
  });
});

describe("switchToTabByIndex", () => {
  function withTabs(n: number): TabsState {
    const tabs = Array.from({ length: n }, () => createTab("home"));
    return { tabs, activeTabId: tabs[0]!.id, recentlyClosed: [] };
  }

  it("Cmd+1..8 jumps to tab N (1-indexed)", () => {
    const s = withTabs(5);
    expect(switchToTabByIndex(s, 1).activeTabId).toBe(s.tabs[0]!.id);
    expect(switchToTabByIndex(s, 3).activeTabId).toBe(s.tabs[2]!.id);
    expect(switchToTabByIndex(s, 5).activeTabId).toBe(s.tabs[4]!.id);
  });

  it("Cmd+9 jumps to the rightmost tab regardless of count (Chrome convention)", () => {
    const small = withTabs(3);
    expect(switchToTabByIndex(small, 9).activeTabId).toBe(small.tabs[2]!.id);
    const big = withTabs(12);
    expect(switchToTabByIndex(big, 9).activeTabId).toBe(big.tabs[11]!.id);
  });

  it("Cmd+1..8 no-op when N > tab count", () => {
    const s = withTabs(3);
    expect(switchToTabByIndex(s, 4)).toBe(s);
    expect(switchToTabByIndex(s, 8)).toBe(s);
  });

  it("returns input unchanged on empty tab list", () => {
    const s: TabsState = { tabs: [], activeTabId: "", recentlyClosed: [] };
    expect(switchToTabByIndex(s, 1)).toBe(s);
    expect(switchToTabByIndex(s, 9)).toBe(s);
  });
});

describe("nextTab / prevTab (wrapping)", () => {
  it("nextTab wraps from rightmost to leftmost", () => {
    const a = createTab("home");
    const b = createTab("work");
    const c = createTab("ops");
    const s: TabsState = { tabs: [a, b, c], activeTabId: c.id, recentlyClosed: [] };
    expect(nextTab(s).activeTabId).toBe(a.id);
  });

  it("prevTab wraps from leftmost to rightmost", () => {
    const a = createTab("home");
    const b = createTab("work");
    const c = createTab("ops");
    const s: TabsState = { tabs: [a, b, c], activeTabId: a.id, recentlyClosed: [] };
    expect(prevTab(s).activeTabId).toBe(c.id);
  });

  it("no-op when there's only one tab", () => {
    const s = initialTabsState();
    expect(nextTab(s)).toBe(s);
    expect(prevTab(s)).toBe(s);
  });
});

describe("deriveTitle (PRD §4.3 precedence)", () => {
  it("user-set title wins over everything else", () => {
    const t = createTab("people", {
      userTitle: "Q3 prep",
      peopleProfile: {
        slug: "x",
        label: "Alice",
        rel_path: "areas/one-on-ones/direct-reports/alice",
      },
      openDoc: { relPath: "x.md", label: "x" },
    });
    expect(deriveTitle(t)).toBe("Q3 prep");
  });

  it("blank user-set title is ignored", () => {
    const t = createTab("people", {
      userTitle: "   ",
      peopleProfile: {
        slug: "x",
        label: "Alice",
        rel_path: "areas/one-on-ones/direct-reports/alice",
      },
    });
    expect(deriveTitle(t)).toBe("Alice");
  });

  it("open document label is used when no user title — distinctive labels pass through", () => {
    const t = createTab("home", {
      openDoc: {
        relPath: "areas/projects/foo/strategy.md",
        label: "Strategy",
      },
    });
    expect(deriveTitle(t)).toBe("Strategy");
  });

  it("generic session-date labels are decorated with the owner segment (matches Recent)", () => {
    // Mirrors the Sidebar's Recent decoration: "2026-04-22" alone is
    // useless in the tab strip, so prefix the person slug.
    const t = createTab("people", {
      openDoc: {
        relPath:
          "areas/one-on-ones/direct-reports/alice/sessions/2026-04-22.md",
        label: "2026-04-22",
      },
    });
    expect(deriveTitle(t)).toBe("Alice · 2026-04-22");
  });

  it("generic README label is decorated with the project slug", () => {
    const t = createTab("projects", {
      openDoc: {
        relPath: "projects/bank-approval-queue/README.md",
        label: "README",
      },
    });
    expect(deriveTitle(t)).toBe("Bank Approval Queue · README");
  });

  it("falls back to a humanized owner segment when openDoc has no label", () => {
    // `decorateRecentLabel` returns just the owner when the label is
    // empty and a meaningful parent segment is found in the relPath.
    const t = createTab("home", {
      openDoc: {
        relPath: "areas/meetings/team-eng-leads/sessions/2026-05-04.md",
        label: "",
      },
    });
    expect(deriveTitle(t)).toBe("Team Eng Leads");
  });

  it("selected entity label when no doc is open", () => {
    expect(
      deriveTitle(
        createTab("people", {
          peopleProfile: {
            slug: "x",
            label: "Alice",
            rel_path: "x",
          },
        }),
      ),
    ).toBe("Alice");
    expect(
      deriveTitle(
        createTab("projects", {
          projectProfile: {
            slug: "x",
            label: "Bank Approval Queue",
            rel_path: "x",
          },
        }),
      ),
    ).toBe("Bank Approval Queue");
    expect(
      deriveTitle(
        createTab("meetings", {
          meetingProfile: {
            slug: "x",
            label: "Team Eng Leads",
            rel_path: "x",
          },
        }),
      ),
    ).toBe("Team Eng Leads");
  });

  it("falls back to surface label when no document or entity is selected", () => {
    expect(deriveTitle(createTab("home"))).toBe("Home");
    expect(deriveTitle(createTab("work"))).toBe("Tasks");
    expect(deriveTitle(createTab("ops"))).toBe("Ops");
  });
});

describe("intentFromEvent", () => {
  it("plain click → current", () => {
    expect(intentFromEvent({})).toBe("current");
    expect(intentFromEvent({ button: 0 })).toBe("current");
  });

  it("Cmd-click → new-bg", () => {
    expect(intentFromEvent({ metaKey: true })).toBe("new-bg");
    expect(intentFromEvent({ ctrlKey: true })).toBe("new-bg");
  });

  it("Cmd+Shift-click → new-fg", () => {
    expect(intentFromEvent({ metaKey: true, shiftKey: true })).toBe("new-fg");
    expect(intentFromEvent({ ctrlKey: true, shiftKey: true })).toBe("new-fg");
  });

  it("middle-click → new-bg (matches Cmd-click)", () => {
    expect(intentFromEvent({ button: 1 })).toBe("new-bg");
    // Middle wins over Shift alone.
    expect(intentFromEvent({ button: 1, shiftKey: true })).toBe("new-bg");
  });

  it("Shift alone (no Cmd, no middle) → current", () => {
    expect(intentFromEvent({ shiftKey: true })).toBe("current");
  });
});

describe("tabsEnabled / setTabsEnabled (kill switch)", () => {
  it("defaults to true when no flag is set", () => {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem("cos.tabs.enabled");
    }
    expect(tabsEnabled()).toBe(true);
  });

  it("returns false only when explicitly disabled", () => {
    setTabsEnabled(false);
    expect(tabsEnabled()).toBe(false);
    setTabsEnabled(true);
    expect(tabsEnabled()).toBe(true);
  });
});

describe("nav history (back/forward)", () => {
  function singleTab(): TabsState {
    const t = createTab("home");
    return { tabs: [t], activeTabId: t.id, recentlyClosed: [] };
  }

  it("pushes prev nav onto backStack when surface changes", () => {
    let s = singleTab();
    expect(canGoBack(activeTab(s))).toBe(false);
    s = updateActiveTab(s, () => ({ surface: "work" }));
    expect(activeTab(s).surface).toBe("work");
    expect(canGoBack(activeTab(s))).toBe(true);
    expect(activeTab(s).backStack).toHaveLength(1);
    expect(activeTab(s).backStack![0]!.surface).toBe("home");
  });

  it("does NOT push history for non-nav mutations", () => {
    let s = singleTab();
    s = updateActiveTab(s, () => ({ sideOpen: true }));
    expect(canGoBack(activeTab(s))).toBe(false);
    expect(activeTab(s).backStack ?? []).toHaveLength(0);
  });

  it("does NOT push history when nav identity is unchanged", () => {
    // Same project slug, fresh object reference — should be a no-op.
    let s = singleTab();
    const proj = {
      slug: "alpha",
      label: "Alpha",
      rel_path: "data/files/projects/alpha",
    };
    s = updateActiveTab(s, () => ({
      surface: "projects",
      projectProfile: proj,
    }));
    expect(activeTab(s).backStack).toHaveLength(1);
    // Re-set the same project — different object, same slug.
    s = updateActiveTab(s, () => ({
      surface: "projects",
      projectProfile: { ...proj },
    }));
    expect(activeTab(s).backStack).toHaveLength(1);
  });

  it("goBack pops backStack and pushes current onto forwardStack", () => {
    let s = singleTab();
    s = updateActiveTab(s, () => ({ surface: "work" }));
    s = updateActiveTab(s, () => ({ surface: "projects" }));
    expect(activeTab(s).backStack).toHaveLength(2);

    s = goBack(s);
    expect(activeTab(s).surface).toBe("work");
    expect(activeTab(s).backStack).toHaveLength(1);
    expect(activeTab(s).forwardStack).toHaveLength(1);
    expect(activeTab(s).forwardStack![0]!.surface).toBe("projects");

    s = goBack(s);
    expect(activeTab(s).surface).toBe("home");
    expect(activeTab(s).backStack ?? []).toHaveLength(0);
    expect(activeTab(s).forwardStack).toHaveLength(2);
  });

  it("goForward inverts goBack", () => {
    let s = singleTab();
    s = updateActiveTab(s, () => ({ surface: "work" }));
    s = goBack(s);
    expect(activeTab(s).surface).toBe("home");
    s = goForward(s);
    expect(activeTab(s).surface).toBe("work");
    expect(canGoForward(activeTab(s))).toBe(false);
  });

  it("a new navigation after a back clears the forward stack", () => {
    let s = singleTab();
    s = updateActiveTab(s, () => ({ surface: "work" }));
    s = updateActiveTab(s, () => ({ surface: "projects" }));
    s = goBack(s);
    expect(activeTab(s).forwardStack).toHaveLength(1);
    s = updateActiveTab(s, () => ({ surface: "people" }));
    expect(activeTab(s).forwardStack ?? []).toHaveLength(0);
    expect(activeTab(s).surface).toBe("people");
  });

  it("back/forward jumps across hierarchies (project → 1:1 → back)", () => {
    let s = singleTab();
    s = updateActiveTab(s, () => ({
      surface: "projects",
      projectProfile: {
        slug: "alpha",
        label: "Alpha",
        rel_path: "data/files/projects/alpha",
      },
      openDoc: {
        relPath: "data/files/projects/alpha/index.html",
        label: "index",
      },
    }));
    s = updateActiveTab(s, () => ({
      surface: "people",
      projectProfile: null,
      peopleProfile: {
        slug: "alice",
        label: "Alice",
        rel_path: "data/files/areas/one-on-ones/direct-reports/alice",
      },
      openDoc: {
        relPath:
          "data/files/areas/one-on-ones/direct-reports/alice/sessions/2026-05-06.md",
        label: "2026-05-06",
      },
    }));
    expect(activeTab(s).surface).toBe("people");
    s = goBack(s);
    expect(activeTab(s).surface).toBe("projects");
    expect(activeTab(s).openDoc?.relPath).toBe(
      "data/files/projects/alpha/index.html",
    );
    expect(activeTab(s).peopleProfile).toBeNull();
  });

  it("caps each stack at NAV_HISTORY_MAX", () => {
    let s = singleTab();
    for (let i = 0; i < NAV_HISTORY_MAX + 5; i++) {
      const target = i % 2 === 0 ? "work" : "home";
      s = updateActiveTab(s, () => ({ surface: target }));
    }
    expect(activeTab(s).backStack!.length).toBe(NAV_HISTORY_MAX);
  });

  it("goBack / goForward are no-ops when their stacks are empty", () => {
    let s = singleTab();
    const before = s;
    s = goBack(s);
    expect(s).toBe(before);
    s = goForward(s);
    expect(s).toBe(before);
  });

  it("history is per-tab — switching tabs doesn't leak", () => {
    const a = createTab("home");
    const b = createTab("work");
    let s: TabsState = {
      tabs: [a, b],
      activeTabId: a.id,
      recentlyClosed: [],
    };
    s = updateActiveTab(s, () => ({ surface: "projects" }));
    expect(activeTab(s).backStack).toHaveLength(1);
    s = switchTab(s, b.id);
    expect(canGoBack(activeTab(s))).toBe(false);
    s = switchTab(s, a.id);
    expect(canGoBack(activeTab(s))).toBe(true);
  });
});
