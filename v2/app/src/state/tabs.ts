/**
 * PRD-v2-117 Stage 1: TabState + TabsState + a small reducer.
 *
 * Stage 1 introduces the type and the data shape only — Shell.tsx
 * holds a single-element `tabs` array and routes every existing
 * navigation through the helpers below. No tab UI yet; the app
 * behaves identically. Stages 2+ wire the strip, persistence, and
 * keyboard model on top of this same data shape.
 */

import { type OpenDoc } from "./openDoc";
import { decorateRecentLabel } from "./recentDocs";
import { findSurface, type SurfaceId } from "./surfaces";
import { type MeetingTarget } from "../surfaces/MeetingDetail";
import { type ProfileTarget } from "../surfaces/PersonProfile";
import { type ProjectTarget } from "../surfaces/ProjectDetail";
import { type V1Task } from "../surfaces/Work";

/**
 * Open intent threaded through every navigation affordance — sidebar,
 * palette result, person/project/meeting tile, in-document link.
 *
 * - "current": mutate the active tab in place (today's behavior; the
 *   default for a plain click)
 * - "new-bg": open in a new tab without switching to it (Cmd+click,
 *   middle-click)
 * - "new-fg": open in a new tab and switch (Cmd+Shift+click)
 *
 * Resolved from the originating mouse event by `intentFromEvent`.
 */
export type OpenIntent = "current" | "new-bg" | "new-fg";

/** Map a click event's modifier keys to an OpenIntent. */
export function intentFromEvent(e: {
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  button?: number;
}): OpenIntent {
  // Middle click ≡ Cmd-click (background). PRD §4.4.3.
  if (e.button === 1) return "new-bg";
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.shiftKey) return "new-fg";
  if (mod) return "new-bg";
  return "current";
}

/**
 * Per-tab navigation history snapshot — the slice of TabState that a
 * Back/Forward button can roll the tab to. Selection (selectedTask),
 * panel visibility (sideOpen), scroll hints, and the user-set title
 * are intentionally excluded: they aren't navigation, and including
 * them would make Back trip on noise (e.g., toggling the side panel).
 */
export type NavSnapshot = {
  surface: SurfaceId;
  peopleProfile: ProfileTarget | null;
  projectProfile: ProjectTarget | null;
  meetingProfile: MeetingTarget | null;
  openDoc: OpenDoc | null;
};

/** Cap each direction's history at 50 entries. */
export const NAV_HISTORY_MAX = 50;

/**
 * The complete navigation context for one tab.
 *
 * Stage 1 captures the eight Shell-local fields the PRD §4.12
 * promotes into the per-tab record. Fields the PRD lists but Stage 1
 * doesn't yet need (workSubTab, opsSubTab, scrollY, selection, etc.)
 * are documented in the type but optional — they fill in as later
 * stages need them, with zero migration burden because the schema
 * is already shaped for them.
 */
export type TabState = {
  /** crypto.randomUUID(); stable per tab, survives reload. Opaque. */
  id: string;
  /**
   * User-set title; absent means the auto-derived title is in effect.
   * Carried through the recently-closed ring buffer (PRD §4.5) so
   * Cmd+Shift+T restores the rename.
   */
  userTitle?: string;
  /** Sticky-left, can't be dragged right of unpinned. */
  pinned?: boolean;
  /** Active surface — sidebar highlight tracks this. */
  surface: SurfaceId;
  /** Surface-specific selection. At most one is non-null. */
  peopleProfile: ProfileTarget | null;
  projectProfile: ProjectTarget | null;
  meetingProfile: MeetingTarget | null;
  /** Open document overlay (lives over the surface, like today). */
  openDoc: OpenDoc | null;
  /** Side panel state (selected task + open/closed). */
  selectedTask: V1Task | null;
  sideOpen: boolean;
  /**
   * Object-identity-driven scroll hint sent to Work — each new
   * `{id}` instance triggers Work's bucket-expand + scroll-to-row.
   */
  taskScrollHint: { id: string } | null;
  /** ISO timestamp; for stable tie-breaking when sorting. */
  createdAt: string;
  /** ISO timestamp; updated on activate, drives palette recency. */
  lastActiveAt: string;
  /**
   * Per-tab back/forward history. Each entry is a NavSnapshot of the
   * nav fields BEFORE that navigation happened. `updateActiveTab`
   * pushes onto `backStack` and clears `forwardStack` whenever the
   * patch changes nav identity (surface / profile / openDoc); plain
   * mutations (selectedTask, sideOpen, etc.) leave both stacks alone.
   * `goBack` / `goForward` rotate snapshots between the stacks.
   * Capped at NAV_HISTORY_MAX per direction.
   */
  backStack?: NavSnapshot[];
  forwardStack?: NavSnapshot[];
};

/**
 * The wrapping state at the workspace level. Stage 1 always holds
 * exactly one tab; Stages 2+ relax that to many.
 */
export type TabsState = {
  tabs: TabState[];
  activeTabId: string;
  /**
   * Ring buffer for Cmd+Shift+T (PRD §4.4.1). Capped at
   * `RECENTLY_CLOSED_MAX`; oldest entries fall off when full.
   */
  recentlyClosed: { state: TabState; closedAt: string }[];
};

/** PRD §4.5: ring buffer cap for the Cmd+Shift+T history. */
export const RECENTLY_CLOSED_MAX = 10;

/**
 * PRD §4.7 / criterion #14: a tab "has an in-flight skill run" iff
 * any active run targets one of its addressable identities (people /
 * project / meeting slug, or the open doc's relPath). Surface-scoped
 * runs (whose ids have no `:` separator — e.g. `morning-briefing`,
 * `weekly-review`) are deliberately filtered out so the entire Home
 * column doesn't blink.
 *
 * Pure function, takes the registry's running array as input — the
 * caller subscribes via `useRunning()` and threads the result here.
 */
export function tabHasRunningSkill(
  tab: TabState,
  runs: { id: string; state: "running" | "done" | "error" }[],
): boolean {
  if (runs.length === 0) return false;
  const targets: string[] = [];
  if (tab.peopleProfile?.slug) targets.push(tab.peopleProfile.slug);
  if (tab.projectProfile?.slug) targets.push(tab.projectProfile.slug);
  if (tab.meetingProfile?.slug) targets.push(tab.meetingProfile.slug);
  if (tab.openDoc?.relPath) targets.push(tab.openDoc.relPath);
  if (targets.length === 0) return false;
  return runs.some(
    (r) =>
      r.state === "running" &&
      r.id.includes(":") &&
      targets.some((t) => t.length > 0 && r.id.includes(t)),
  );
}

/** Stable, dependency-free id generator. */
function newId(): string {
  if (
    typeof globalThis !== "undefined" &&
    typeof globalThis.crypto?.randomUUID === "function"
  ) {
    return globalThis.crypto.randomUUID();
  }
  // Test environments without crypto.randomUUID — best-effort fallback.
  return `tab-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

/** Default-construct a tab parked on the given surface. */
export function createTab(
  surface: SurfaceId = "home",
  overrides: Partial<TabState> = {},
): TabState {
  const now = new Date().toISOString();
  return {
    id: newId(),
    surface,
    peopleProfile: null,
    projectProfile: null,
    meetingProfile: null,
    openDoc: null,
    selectedTask: null,
    sideOpen: false,
    taskScrollHint: null,
    createdAt: now,
    lastActiveAt: now,
    ...overrides,
  };
}

/** Initial workspace state — exactly one Home tab. */
export function initialTabsState(): TabsState {
  const t = createTab("home");
  return { tabs: [t], activeTabId: t.id, recentlyClosed: [] };
}

/** Read the active tab. Throws if `activeTabId` doesn't resolve — that
 *  would be a bug, not a recoverable state. */
export function activeTab(s: TabsState): TabState {
  const t = s.tabs.find((x) => x.id === s.activeTabId);
  if (!t) {
    throw new Error(
      `tabs invariant: activeTabId ${s.activeTabId} not in tabs (have ${s.tabs.map((x) => x.id).join(", ") || "none"})`,
    );
  }
  return t;
}

/**
 * Capture the navigation slice of a TabState — used by
 * `updateActiveTab` to push the *previous* nav onto backStack when a
 * new navigation lands, and by `goBack`/`goForward` to rotate
 * snapshots between the two stacks.
 */
export function snapshotNav(t: TabState): NavSnapshot {
  return {
    surface: t.surface,
    peopleProfile: t.peopleProfile,
    projectProfile: t.projectProfile,
    meetingProfile: t.meetingProfile,
    openDoc: t.openDoc,
  };
}

/**
 * Stable identity string for the nav slice. We compare by stringified
 * key — that way a `goToProject(target)` to the project the user is
 * already on is correctly detected as a no-op (the `target` object
 * has a fresh reference each call, but its slug is the same), so
 * Back doesn't fill up with duplicates.
 */
function navIdentity(n: NavSnapshot): string {
  return [
    n.surface,
    n.peopleProfile?.slug ?? "",
    n.projectProfile?.slug ?? "",
    n.meetingProfile?.slug ?? "",
    n.openDoc?.relPath ?? "",
  ].join("|");
}

export function canGoBack(t: TabState): boolean {
  return (t.backStack?.length ?? 0) > 0;
}

export function canGoForward(t: TabState): boolean {
  return (t.forwardStack?.length ?? 0) > 0;
}

/**
 * Apply a mutation function to the active tab; returns a new
 * `TabsState`. The mutator receives the current active tab and
 * returns the next one (or partial fields to spread). Pure: callers
 * are responsible for any side effects (recordRecent, perf marks).
 *
 * If the patch changes nav identity (surface / profile / openDoc),
 * the *previous* nav slice is pushed onto `backStack` and
 * `forwardStack` is cleared — same shape as a browser address bar.
 * Non-nav mutations (selectedTask, sideOpen, taskScrollHint, etc.)
 * leave the history stacks untouched.
 */
export function updateActiveTab(
  s: TabsState,
  mut: (t: TabState) => Partial<TabState> | TabState,
): TabsState {
  const next = s.tabs.map((t) => {
    if (t.id !== s.activeTabId) return t;
    const patch = mut(t);
    // Allow either a partial (treated as Object.assign) or a full
    // replacement. Both produce a new object so React sees the
    // change.
    const merged: TabState = { ...t, ...patch };
    const prevId = navIdentity(snapshotNav(t));
    const nextId = navIdentity(snapshotNav(merged));
    if (prevId === nextId) {
      // Non-nav mutation — leave history alone.
      return merged;
    }
    const nextBack = [...(t.backStack ?? []), snapshotNav(t)].slice(
      -NAV_HISTORY_MAX,
    );
    return {
      ...merged,
      backStack: nextBack,
      forwardStack: [],
    };
  });
  return { ...s, tabs: next };
}

/**
 * Pop the last entry off the active tab's `backStack`, push the
 * current nav onto `forwardStack`, and apply the popped snapshot.
 * No-op when the stack is empty. Selection / sideOpen / scroll
 * hints are left as-is — a Back doesn't blow away the user's
 * task selection or the side panel state.
 */
export function goBack(s: TabsState): TabsState {
  const t = activeTab(s);
  const back = t.backStack ?? [];
  if (back.length === 0) return s;
  const target = back[back.length - 1]!;
  const remaining = back.slice(0, -1);
  const current = snapshotNav(t);
  const tabs = s.tabs.map((x) =>
    x.id !== t.id
      ? x
      : {
          ...x,
          ...target,
          backStack: remaining,
          forwardStack: [...(x.forwardStack ?? []), current].slice(
            -NAV_HISTORY_MAX,
          ),
        },
  );
  return { ...s, tabs };
}

/**
 * Inverse of `goBack`. Pops `forwardStack`, pushes the current nav
 * onto `backStack`, applies the popped snapshot. No-op when the
 * forward stack is empty.
 */
export function goForward(s: TabsState): TabsState {
  const t = activeTab(s);
  const fwd = t.forwardStack ?? [];
  if (fwd.length === 0) return s;
  const target = fwd[fwd.length - 1]!;
  const remaining = fwd.slice(0, -1);
  const current = snapshotNav(t);
  const tabs = s.tabs.map((x) =>
    x.id !== t.id
      ? x
      : {
          ...x,
          ...target,
          backStack: [...(x.backStack ?? []), current].slice(
            -NAV_HISTORY_MAX,
          ),
          forwardStack: remaining,
        },
  );
  return { ...s, tabs };
}

/**
 * Append a new tab to the right end of the strip. Pinned tabs are
 * sticky-left (PRD §4.2); for Stage 2 with no pin support yet, an
 * unpinned new tab simply pushes onto the end. When pin support
 * lands, this will insert at the boundary between the pinned and
 * unpinned regions.
 *
 * `activate=true` means the new tab is also focused (Cmd+T,
 * Cmd+Shift+click); `false` is background (Cmd+click, middle-click).
 */
export function appendTab(
  s: TabsState,
  tab: TabState,
  activate: boolean,
): TabsState {
  const tabs = [...s.tabs, tab];
  return {
    tabs,
    activeTabId: activate ? tab.id : s.activeTabId,
    recentlyClosed: s.recentlyClosed,
  };
}

/**
 * Close a tab by id. Returns a new TabsState.
 *
 * - If the tab isn't found, returns the input unchanged.
 * - If it's the only remaining tab, the **last-tab guard** (PRD
 *   §4.4.1) replaces it with a fresh Home tab in place rather than
 *   leaving an empty strip. The replaced tab is *not* pushed onto
 *   the recently-closed ring (it would be confusing to "reopen" a
 *   freshly-replaced Home tab).
 * - If the closing tab was active, focus moves to the right
 *   neighbor; if there's nothing to the right, the left neighbor.
 *
 * Closed tabs (in the non-last-tab path) are pushed onto the
 * recently-closed ring so Cmd+Shift+T can resurrect them. Only the
 * 10 most recent entries are kept; oldest fall off. Closing a Home
 * tab with no selection / openDoc is filtered out — there's nothing
 * meaningful to reopen, and it would crowd out real entries.
 */
export function closeTab(s: TabsState, tabId: string): TabsState {
  const idx = s.tabs.findIndex((t) => t.id === tabId);
  if (idx < 0) return s;
  const closing = s.tabs[idx]!;

  if (s.tabs.length === 1) {
    const fresh = createTab("home");
    return {
      tabs: [fresh],
      activeTabId: fresh.id,
      recentlyClosed: pushRecentlyClosed(s.recentlyClosed, closing),
    };
  }

  const tabs = s.tabs.filter((_, i) => i !== idx);
  let activeTabId = s.activeTabId;
  if (s.activeTabId === tabId) {
    const neighbor = tabs[idx] ?? tabs[idx - 1] ?? tabs[0];
    if (neighbor) activeTabId = neighbor.id;
  }
  return {
    tabs,
    activeTabId,
    recentlyClosed: pushRecentlyClosed(s.recentlyClosed, closing),
  };
}

/** True if the tab carries any meaningful navigation state (a doc,
 *  a selected entity, a non-Home surface, or a user-set title).
 *  Empty Home tabs aren't worth pushing onto the ring buffer — they
 *  clutter the Cmd+Shift+T history and a user reopening "an empty
 *  Home tab" would be confusing. */
function hasMeaningfulState(t: TabState): boolean {
  if (t.userTitle && t.userTitle.trim().length > 0) return true;
  if (t.openDoc) return true;
  if (t.peopleProfile) return true;
  if (t.projectProfile) return true;
  if (t.meetingProfile) return true;
  if (t.surface !== "home") return true;
  return false;
}

function pushRecentlyClosed(
  ring: TabsState["recentlyClosed"],
  closing: TabState,
): TabsState["recentlyClosed"] {
  if (!hasMeaningfulState(closing)) return ring;
  const entry = { state: closing, closedAt: new Date().toISOString() };
  // Newest at the front; cap at RECENTLY_CLOSED_MAX. We push to the
  // FRONT because Cmd+Shift+T (reopenLastClosedTab) pops from the
  // front — last-closed-first.
  return [entry, ...ring].slice(0, RECENTLY_CLOSED_MAX);
}

/**
 * Cmd+Shift+T (PRD §4.4.1, criterion #8): pop the most recently
 * closed tab off the ring and append it to the strip with a fresh
 * id (we want a new tab, not a duplicate of one that may also still
 * exist somewhere). The userTitle rides through (PRD §4.3 / §4.5),
 * so a renamed-then-closed tab comes back with the rename intact.
 *
 * Returns the input unchanged when the ring is empty.
 */
export function reopenLastClosedTab(s: TabsState): TabsState {
  if (s.recentlyClosed.length === 0) return s;
  const [head, ...rest] = s.recentlyClosed;
  if (!head) return s;
  // Strip the id so the resurrected tab is a fresh entity in the
  // strip — preserves the rest of the navigation state.
  const { id: _id, ...rest_state } = head.state;
  void _id;
  const resurrected = createTab(head.state.surface, rest_state);
  return {
    tabs: [...s.tabs, resurrected],
    activeTabId: resurrected.id,
    recentlyClosed: rest,
  };
}

/**
 * Switch the active tab. No-op if the id isn't in `tabs` or is
 * already active. Updates `lastActiveAt` on the newly active tab so
 * the palette's recency ordering (PRD §4.9) is correct.
 */
export function switchTab(s: TabsState, tabId: string): TabsState {
  if (s.activeTabId === tabId) return s;
  if (!s.tabs.find((t) => t.id === tabId)) return s;
  const now = new Date().toISOString();
  const tabs = s.tabs.map((t) =>
    t.id === tabId ? { ...t, lastActiveAt: now } : t,
  );
  return { tabs, activeTabId: tabId, recentlyClosed: s.recentlyClosed };
}

/**
 * PRD §3 row #2: Cmd+1..8 → tab N (1-indexed); Cmd+9 →
 * **rightmost** tab regardless of count. Both no-op silently when
 * the index is out of range or `tabs` is empty.
 */
export function switchToTabByIndex(s: TabsState, index: number): TabsState {
  if (s.tabs.length === 0) return s;
  if (index === 9) {
    const last = s.tabs[s.tabs.length - 1]!;
    return switchTab(s, last.id);
  }
  if (index < 1 || index > 8) return s;
  const target = s.tabs[index - 1];
  if (!target) return s;
  return switchTab(s, target.id);
}

/**
 * Drag-reorder: move a tab from `fromIndex` to land at `toIndex`
 * (PRD §4.2 / criterion #12). The pin-region constraint (pinned
 * tabs stay leftmost, can't be dragged past unpinned ones) is
 * enforced by clamping `toIndex` to the pinned/unpinned region the
 * dragged tab belongs to.
 *
 * Returns the input unchanged for no-op moves or invalid indices.
 */
export function moveTab(
  s: TabsState,
  fromIndex: number,
  toIndex: number,
): TabsState {
  if (fromIndex < 0 || fromIndex >= s.tabs.length) return s;
  if (toIndex < 0 || toIndex > s.tabs.length) return s;
  if (toIndex === fromIndex || toIndex === fromIndex + 1) return s;

  const moving = s.tabs[fromIndex]!;
  const pinnedCount = s.tabs.filter((t) => t.pinned).length;

  // Clamp the destination to the dragged tab's pin region. A pinned
  // tab can move within [0, pinnedCount); an unpinned tab can move
  // within [pinnedCount, tabs.length].
  let clampedTo = toIndex;
  if (moving.pinned) {
    if (clampedTo > pinnedCount) clampedTo = pinnedCount;
  } else {
    if (clampedTo < pinnedCount) clampedTo = pinnedCount;
  }
  if (clampedTo === fromIndex || clampedTo === fromIndex + 1) return s;

  // Splice: remove from the old slot, insert at the new one. The
  // new index shifts left by one when removing from before the
  // destination.
  const without = s.tabs.filter((_, i) => i !== fromIndex);
  const insertAt = clampedTo > fromIndex ? clampedTo - 1 : clampedTo;
  const tabs = [
    ...without.slice(0, insertAt),
    moving,
    ...without.slice(insertAt),
  ];
  return { ...s, tabs };
}

/**
 * Pin a tab. Pinned tabs are sticky-left (PRD §4.2): when pinned, a
 * tab moves to the right end of the pinned region (so existing pins
 * keep their order; the newest pin lands rightmost among pinned).
 *
 * No-op when the id isn't found or the tab is already pinned.
 */
export function pinTab(s: TabsState, tabId: string): TabsState {
  const idx = s.tabs.findIndex((t) => t.id === tabId);
  if (idx < 0) return s;
  const target = s.tabs[idx]!;
  if (target.pinned) return s;
  const updated: TabState = { ...target, pinned: true };
  const without = s.tabs.filter((_, i) => i !== idx);
  const boundary = without.filter((t) => t.pinned).length;
  return {
    ...s,
    tabs: [
      ...without.slice(0, boundary),
      updated,
      ...without.slice(boundary),
    ],
  };
}

/**
 * Unpin a tab. The tab moves to the left end of the unpinned region
 * (immediately after the last pinned tab) so it doesn't lose its
 * position relative to other unpinned tabs.
 *
 * No-op when the id isn't found or the tab is already unpinned.
 */
export function unpinTab(s: TabsState, tabId: string): TabsState {
  const idx = s.tabs.findIndex((t) => t.id === tabId);
  if (idx < 0) return s;
  const target = s.tabs[idx]!;
  if (!target.pinned) return s;
  const updated: TabState = { ...target, pinned: false };
  const without = s.tabs.filter((_, i) => i !== idx);
  const boundary = without.filter((t) => t.pinned).length;
  return {
    ...s,
    tabs: [
      ...without.slice(0, boundary),
      updated,
      ...without.slice(boundary),
    ],
  };
}

/**
 * Set or clear the user-set title of the active tab. An empty
 * string clears the override (PRD §4.3 "reset to auto").
 */
export function renameTab(
  s: TabsState,
  tabId: string,
  title: string,
): TabsState {
  const trimmed = title.trim();
  return {
    ...s,
    tabs: s.tabs.map((t) =>
      t.id === tabId
        ? { ...t, userTitle: trimmed.length === 0 ? undefined : trimmed }
        : t,
    ),
  };
}

/**
 * Duplicate the right-clicked tab — copies its TabState (with a
 * fresh id) and inserts to the immediate right of the source. PRD
 * §4.10 right-click menu.
 */
export function duplicateTab(s: TabsState, tabId: string): TabsState {
  const idx = s.tabs.findIndex((t) => t.id === tabId);
  if (idx < 0) return s;
  const source = s.tabs[idx]!;
  // Duplicates of a pinned tab become unpinned — Chrome's behavior;
  // pinning is a deliberate user action, not a property of the tab.
  const { id: _id, pinned: _pinned, ...rest } = source;
  void _id;
  void _pinned;
  const dup = createTab(source.surface, rest);
  return {
    ...s,
    tabs: [...s.tabs.slice(0, idx + 1), dup, ...s.tabs.slice(idx + 1)],
  };
}

/**
 * "Close other tabs" — closes every unpinned tab except `keepId`.
 * Pinned tabs are spared (PRD §4.10).
 */
export function closeOtherTabs(s: TabsState, keepId: string): TabsState {
  const survivors = s.tabs.filter((t) => t.id === keepId || t.pinned);
  if (survivors.length === s.tabs.length) return s;
  const closing = s.tabs.filter((t) => t.id !== keepId && !t.pinned);
  let recentlyClosed = s.recentlyClosed;
  for (const t of closing) {
    recentlyClosed = pushRecentlyClosed(recentlyClosed, t);
  }
  return {
    tabs: survivors,
    activeTabId: survivors.find((t) => t.id === s.activeTabId)
      ? s.activeTabId
      : (survivors.find((t) => t.id === keepId) ?? survivors[0]!).id,
    recentlyClosed,
  };
}

/**
 * "Close tabs to the right" — closes every unpinned tab to the
 * right of the anchor tab.
 */
export function closeTabsToTheRight(
  s: TabsState,
  anchorId: string,
): TabsState {
  const idx = s.tabs.findIndex((t) => t.id === anchorId);
  if (idx < 0) return s;
  const closing = s.tabs.slice(idx + 1).filter((t) => !t.pinned);
  if (closing.length === 0) return s;
  const survivors = [
    ...s.tabs.slice(0, idx + 1),
    ...s.tabs.slice(idx + 1).filter((t) => t.pinned),
  ];
  let recentlyClosed = s.recentlyClosed;
  for (const t of closing) {
    recentlyClosed = pushRecentlyClosed(recentlyClosed, t);
  }
  return {
    tabs: survivors,
    activeTabId: survivors.find((t) => t.id === s.activeTabId)
      ? s.activeTabId
      : survivors[0]!.id,
    recentlyClosed,
  };
}

/** Cycle to the next tab (wraps). PRD §4.4.1: Cmd+Shift+]. */
export function nextTab(s: TabsState): TabsState {
  if (s.tabs.length <= 1) return s;
  const idx = s.tabs.findIndex((t) => t.id === s.activeTabId);
  if (idx < 0) return s;
  const target = s.tabs[(idx + 1) % s.tabs.length]!;
  return switchTab(s, target.id);
}

/** Cycle to the previous tab (wraps). PRD §4.4.1: Cmd+Shift+[. */
export function prevTab(s: TabsState): TabsState {
  if (s.tabs.length <= 1) return s;
  const idx = s.tabs.findIndex((t) => t.id === s.activeTabId);
  if (idx < 0) return s;
  const target = s.tabs[(idx - 1 + s.tabs.length) % s.tabs.length]!;
  return switchTab(s, target.id);
}

/**
 * Auto-derive a tab's display title per PRD §4.3 precedence:
 *
 *   1. user-set title
 *   2. open document label (decorated with the owner segment when
 *      generic — "2026-04-22" alone is meaningless in a tab; the
 *      sidebar's Recent section solves the same problem with
 *      `decorateRecentLabel`, so the same helper runs here)
 *   3. selected entity label (person / project / meeting)
 *   4. surface label (Home / Tasks / …)
 *
 * Sub-tab labels (Velocity, Service Health) sit between #3 and #4 in
 * the spec but live inside the surfaces' own state today; Stage 2
 * defers them — the surface label is still correct, just less
 * specific. They drop into this function once the per-tab subTab
 * fields land in later stages.
 */
export function deriveTitle(tab: TabState): string {
  const u = tab.userTitle?.trim();
  if (u && u.length > 0) return u;
  if (tab.openDoc) {
    const label = tab.openDoc.label?.trim() ?? "";
    // `decorateRecentLabel` is a no-op for distinctive labels and
    // prefixes the owner ("Alice · 2026-04-22", "Bank Approval Queue
    // · README") for generic ones. The same logic the sidebar uses
    // for its Recent section.
    return decorateRecentLabel(tab.openDoc.relPath, label);
  }
  if (tab.peopleProfile) return tab.peopleProfile.label;
  if (tab.projectProfile) return tab.projectProfile.label;
  if (tab.meetingProfile) return tab.meetingProfile.label;
  try {
    return findSurface(tab.surface).label;
  } catch {
    return tab.surface;
  }
}

/**
 * Kill-switch: PRD §4.12 stage 1 lists `cos.tabs.enabled` as a
 * boolean readable from settings that falls back to the pre-refactor
 * code path. Stage 1 has no UI to fall back, so this is currently a
 * forward-looking probe — Stages 2+ gate the strip render and
 * persistence on this. Default true.
 */
const KILL_SWITCH_KEY = "cos.tabs.enabled";

export function tabsEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(KILL_SWITCH_KEY);
    if (raw === null) return true;
    return raw !== "false";
  } catch {
    return true;
  }
}

export function setTabsEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KILL_SWITCH_KEY, enabled ? "true" : "false");
  } catch {
    // Private mode — best effort. Flag is non-critical.
  }
}
