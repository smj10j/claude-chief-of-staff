import { useEffect } from "react";

import { SURFACES, type SurfaceId } from "./surfaces";

export type GlobalKeyHandlers = {
  setSurface: (id: SurfaceId) => void;
  openPalette: () => void;
  openQuickCapture: () => void;
  toggleSidebar: () => void;
  toggleSidePanel: () => void;
  closeOverlay: () => void;
  toggleShortcuts: () => void;
  closeDoc: () => void;
  // PRD-v2-117 Stage 2 — workspace tab shortcuts.
  newTab: () => void;
  closeTab: () => void;
  switchToTab: (index: number) => void;
  nextTab: () => void;
  prevTab: () => void;
  /** Cmd+Shift+T (PRD-v2-117 Stage 3): reopen the most recently
   *  closed tab from the recently-closed ring buffer. */
  reopenClosedTab: () => void;
  /** F2 — start renaming the active tab inline (PRD §4.4.1). */
  renameActiveTab: () => void;
  /** Cmd+Shift+L — pin / unpin the active tab (PRD §4.4.1). */
  togglePinActiveTab: () => void;
  /** Cmd+[ — back in the active tab's nav history. */
  goBack: () => void;
  /** Cmd+] — forward in the active tab's nav history. */
  goForward: () => void;
};

/**
 * Match a key event to a single GlobalKeyHandlers method name. Pure —
 * separated from the hook so tests don't need a React renderer.
 *
 * Returns:
 *   - the handler name + whether to preventDefault, when the chord matches
 *   - null when nothing fires (handler should ignore)
 *
 * Cmd on macOS, Ctrl elsewhere; we accept both for dev ergonomics.
 */
export type DispatchedKey =
  | { handler: "closeOverlay"; preventDefault: false }
  | { handler: "openPalette"; preventDefault: true }
  | { handler: "openQuickCapture"; preventDefault: true }
  | { handler: "toggleSidebar"; preventDefault: true }
  | { handler: "toggleSidePanel"; preventDefault: true }
  | { handler: "toggleShortcuts"; preventDefault: true }
  | { handler: "closeDoc"; preventDefault: true }
  | { handler: "setSurface"; preventDefault: true; index: number }
  | { handler: "newTab"; preventDefault: true }
  | { handler: "closeTab"; preventDefault: true }
  | { handler: "switchToTab"; preventDefault: true; index: number }
  | { handler: "nextTab"; preventDefault: true }
  | { handler: "prevTab"; preventDefault: true }
  | { handler: "reopenClosedTab"; preventDefault: true }
  | { handler: "renameActiveTab"; preventDefault: true }
  | { handler: "togglePinActiveTab"; preventDefault: true }
  | { handler: "goBack"; preventDefault: true }
  | { handler: "goForward"; preventDefault: true };

export function matchGlobalKey(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey?: boolean;
}): DispatchedKey | null {
  const mod = e.metaKey || e.ctrlKey;
  const alt = !!e.altKey;

  if (e.key === "Escape") {
    return { handler: "closeOverlay", preventDefault: false };
  }

  // F2 → rename active tab. PRD §4.4.1 specifies "tab strip
  // focused" but F2 is otherwise unused in the app, and routing it
  // through the global handler lets the user rename without first
  // tabbing into the strip.
  if (e.key === "F2") {
    return { handler: "renameActiveTab", preventDefault: true };
  }

  if (!mod) return null;

  // Surface chord (PRD-v2-117 §4.4.2) — moved from Cmd+1..6 to
  // Cmd+Opt+1..7 to free up Cmd+1..9 for tab navigation. Order
  // matters: this branch must run before the Cmd+1..9 tab branch
  // below since both match digit keys.
  if (alt && !e.shiftKey) {
    const n = Number(e.key);
    if (Number.isInteger(n) && n >= 1 && n <= 9) {
      const target = SURFACES.find((s) => s.index === n);
      if (target) {
        return { handler: "setSurface", preventDefault: true, index: n };
      }
    }
  }

  // Cmd+T → new workspace tab (PRD-v2-117 §4.4.1). No Shift modifier
  // (Cmd+Shift+T is reopen-closed).
  if ((e.key === "t" || e.key === "T") && !e.shiftKey && !alt) {
    return { handler: "newTab", preventDefault: true };
  }

  // Cmd+Shift+T → reopen most recently closed tab from the
  // recently-closed ring buffer (PRD-v2-117 §4.4.1, criterion #8).
  if ((e.key === "t" || e.key === "T") && e.shiftKey && !alt) {
    return { handler: "reopenClosedTab", preventDefault: true };
  }

  // Cmd+Shift+L → pin / unpin the active tab (PRD-v2-117 §4.4.1).
  // We deliberately avoid Cmd+Shift+P (PRD-100 §6.1 reserves it
  // globally for "process annotations").
  if ((e.key === "l" || e.key === "L") && e.shiftKey && !alt) {
    return { handler: "togglePinActiveTab", preventDefault: true };
  }

  // Cmd+W → close current tab (PRD-v2-117 §4.4.1). Replaces the
  // pre-tab semantic of "close open doc" — closing a doc is now Esc.
  if ((e.key === "w" || e.key === "W") && !e.shiftKey && !alt) {
    return { handler: "closeTab", preventDefault: true };
  }

  if (e.key === "k" || e.key === "K" || e.key === "p" || e.key === "P") {
    // Cmd+P doubles as palette so VSCode muscle memory works.
    if (e.shiftKey || alt) return null;
    return { handler: "openPalette", preventDefault: true };
  }

  // Cmd+N → quick-capture task. Browsers reserve Cmd+N for "new
  // window", but in the Tauri webview no browser is in the way.
  // Cmd+Shift+N stays free (browsers' "new private window") so we
  // explicitly skip when Shift is held.
  if ((e.key === "n" || e.key === "N") && !e.shiftKey && !alt) {
    return { handler: "openQuickCapture", preventDefault: true };
  }

  // Sidebar toggle is Cmd+Shift+B — Cmd+B alone is universal bold.
  if ((e.key === "b" || e.key === "B") && e.shiftKey && !alt) {
    return { handler: "toggleSidebar", preventDefault: true };
  }

  if (e.key === "\\" && !alt) {
    return { handler: "toggleSidePanel", preventDefault: true };
  }

  // Cmd+/ opens (or closes) the keyboard-shortcut cheatsheet. Standard
  // help affordance in most native macOS apps.
  if (e.key === "/" && !alt) {
    return { handler: "toggleShortcuts", preventDefault: true };
  }

  // Cmd+Shift+] / Cmd+Shift+[ → cycle tabs (PRD-v2-117 §4.4.1).
  // The bracket characters arrive on the event's `key` field on
  // most layouts; some non-US layouts send their unshifted form.
  if (e.shiftKey && !alt) {
    if (e.key === "]" || e.key === "}") {
      return { handler: "nextTab", preventDefault: true };
    }
    if (e.key === "[" || e.key === "{") {
      return { handler: "prevTab", preventDefault: true };
    }
  }

  // Cmd+[ / Cmd+] (no Shift) → back / forward in the active tab's
  // nav history. Standard mac convention (Finder, Safari, Xcode).
  if (!e.shiftKey && !alt) {
    if (e.key === "[") {
      return { handler: "goBack", preventDefault: true };
    }
    if (e.key === "]") {
      return { handler: "goForward", preventDefault: true };
    }
  }

  // Cmd+1..9 → switch to tab N (PRD-v2-117 §4.4.1). Cmd+9 is the
  // **rightmost** tab regardless of count (Chrome convention). The
  // reducer (`switchToTabByIndex`) handles the slot semantics; this
  // matcher just dispatches the index.
  if (!e.shiftKey && !alt) {
    const n = Number(e.key);
    if (Number.isInteger(n) && n >= 1 && n <= 9) {
      return { handler: "switchToTab", preventDefault: true, index: n };
    }
  }

  return null;
}

/**
 * Global keybindings per PRD-100 §6.1. Bound to window keydown.
 */
export function useGlobalKeys(h: GlobalKeyHandlers): void {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const matched = matchGlobalKey(e);
      if (!matched) return;
      if (matched.preventDefault) e.preventDefault();
      switch (matched.handler) {
        case "closeOverlay":
          h.closeOverlay();
          return;
        case "openPalette":
          h.openPalette();
          return;
        case "openQuickCapture":
          h.openQuickCapture();
          return;
        case "toggleSidebar":
          h.toggleSidebar();
          return;
        case "toggleSidePanel":
          h.toggleSidePanel();
          return;
        case "toggleShortcuts":
          h.toggleShortcuts();
          return;
        case "closeDoc":
          h.closeDoc();
          return;
        case "setSurface": {
          const target = SURFACES.find((s) => s.index === matched.index);
          if (target) h.setSurface(target.id);
          return;
        }
        case "newTab":
          h.newTab();
          return;
        case "closeTab":
          h.closeTab();
          return;
        case "switchToTab":
          h.switchToTab(matched.index);
          return;
        case "nextTab":
          h.nextTab();
          return;
        case "prevTab":
          h.prevTab();
          return;
        case "reopenClosedTab":
          h.reopenClosedTab();
          return;
        case "renameActiveTab":
          h.renameActiveTab();
          return;
        case "togglePinActiveTab":
          h.togglePinActiveTab();
          return;
        case "goBack":
          h.goBack();
          return;
        case "goForward":
          h.goForward();
          return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [h]);
}
