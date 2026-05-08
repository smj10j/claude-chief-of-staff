import { describe, expect, it } from "vitest";

import { matchGlobalKey } from "./keys";

function ev(
  key: string,
  flags: {
    meta?: boolean;
    ctrl?: boolean;
    shift?: boolean;
    alt?: boolean;
  } = {},
) {
  return {
    key,
    metaKey: flags.meta ?? false,
    ctrlKey: flags.ctrl ?? false,
    shiftKey: flags.shift ?? false,
    altKey: flags.alt ?? false,
  };
}

describe("matchGlobalKey", () => {
  it("returns null for naked letters (no modifier)", () => {
    expect(matchGlobalKey(ev("k"))).toBeNull();
    expect(matchGlobalKey(ev("n"))).toBeNull();
    expect(matchGlobalKey(ev("\\"))).toBeNull();
  });

  it("Escape always closes the overlay (no modifier required)", () => {
    expect(matchGlobalKey(ev("Escape"))).toEqual({
      handler: "closeOverlay",
      preventDefault: false,
    });
  });

  it("Cmd+K opens the palette", () => {
    expect(matchGlobalKey(ev("k", { meta: true }))).toEqual({
      handler: "openPalette",
      preventDefault: true,
    });
    // Ctrl alternative for non-mac dev.
    expect(matchGlobalKey(ev("K", { ctrl: true }))).toEqual({
      handler: "openPalette",
      preventDefault: true,
    });
  });

  it("Cmd+N opens quick capture, Cmd+Shift+N does NOT", () => {
    expect(matchGlobalKey(ev("n", { meta: true }))).toEqual({
      handler: "openQuickCapture",
      preventDefault: true,
    });
    // Shift+Cmd+N is reserved by browsers ("new private window") so we
    // intentionally let it pass through.
    expect(matchGlobalKey(ev("n", { meta: true, shift: true }))).toBeNull();
  });

  it("Cmd+Shift+B toggles sidebar; Cmd+B does not", () => {
    expect(matchGlobalKey(ev("b", { meta: true, shift: true }))).toEqual({
      handler: "toggleSidebar",
      preventDefault: true,
    });
    // Plain Cmd+B is editor bold; should not match the global handler.
    expect(matchGlobalKey(ev("b", { meta: true }))).toBeNull();
  });

  it("Cmd+\\ toggles the side panel", () => {
    expect(matchGlobalKey(ev("\\", { meta: true }))).toEqual({
      handler: "toggleSidePanel",
      preventDefault: true,
    });
  });

  it("Cmd+/ toggles the shortcut cheatsheet", () => {
    expect(matchGlobalKey(ev("/", { meta: true }))).toEqual({
      handler: "toggleShortcuts",
      preventDefault: true,
    });
    // Naked / does not.
    expect(matchGlobalKey(ev("/"))).toBeNull();
  });

  it("Cmd+T opens a new tab; Cmd+Shift+T reopens the most recently closed", () => {
    expect(matchGlobalKey(ev("t", { meta: true }))).toEqual({
      handler: "newTab",
      preventDefault: true,
    });
    expect(matchGlobalKey(ev("t", { meta: true, shift: true }))).toEqual({
      handler: "reopenClosedTab",
      preventDefault: true,
    });
  });

  it("Cmd+W closes the current tab (replaces the pre-tab close-doc semantic)", () => {
    expect(matchGlobalKey(ev("w", { meta: true }))).toEqual({
      handler: "closeTab",
      preventDefault: true,
    });
    // Cmd+Shift+W stays free.
    expect(matchGlobalKey(ev("w", { meta: true, shift: true }))).toBeNull();
  });

  it("Cmd+P aliases the palette", () => {
    expect(matchGlobalKey(ev("p", { meta: true }))).toEqual({
      handler: "openPalette",
      preventDefault: true,
    });
  });

  it("Cmd+1..8 → switchToTab N (PRD-117 §4.4.2 reclaim)", () => {
    for (let i = 1; i <= 8; i++) {
      expect(matchGlobalKey(ev(String(i), { meta: true }))).toEqual({
        handler: "switchToTab",
        preventDefault: true,
        index: i,
      });
    }
  });

  it("Cmd+9 → switchToTab 9 (rightmost — handled by the reducer)", () => {
    expect(matchGlobalKey(ev("9", { meta: true }))).toEqual({
      handler: "switchToTab",
      preventDefault: true,
      index: 9,
    });
  });

  it("Cmd+0 does not match", () => {
    expect(matchGlobalKey(ev("0", { meta: true }))).toBeNull();
  });

  it("Cmd+] / Cmd+[ (no shift) → forward / back in nav history", () => {
    expect(matchGlobalKey(ev("]", { meta: true }))).toEqual({
      handler: "goForward",
      preventDefault: true,
    });
    expect(matchGlobalKey(ev("[", { meta: true }))).toEqual({
      handler: "goBack",
      preventDefault: true,
    });
    expect(matchGlobalKey(ev("[", { ctrl: true }))).toEqual({
      handler: "goBack",
      preventDefault: true,
    });
  });

  it("Cmd+Shift+] / [ cycle tabs", () => {
    expect(matchGlobalKey(ev("]", { meta: true, shift: true }))).toEqual({
      handler: "nextTab",
      preventDefault: true,
    });
    expect(matchGlobalKey(ev("[", { meta: true, shift: true }))).toEqual({
      handler: "prevTab",
      preventDefault: true,
    });
    // Bracket variants from non-US layouts.
    expect(matchGlobalKey(ev("}", { meta: true, shift: true }))).toEqual({
      handler: "nextTab",
      preventDefault: true,
    });
    expect(matchGlobalKey(ev("{", { meta: true, shift: true }))).toEqual({
      handler: "prevTab",
      preventDefault: true,
    });
  });

  it("Cmd+Opt+1..7 → setSurface (PRD-117 §4.4.2 surface chord migration)", () => {
    for (let i = 1; i <= 7; i++) {
      expect(matchGlobalKey(ev(String(i), { meta: true, alt: true }))).toEqual(
        { handler: "setSurface", preventDefault: true, index: i },
      );
    }
    // Cmd+Opt+8 maps to settings (the eighth surface in SURFACES).
    expect(matchGlobalKey(ev("8", { meta: true, alt: true }))).toEqual({
      handler: "setSurface",
      preventDefault: true,
      index: 8,
    });
  });

  it("F2 dispatches renameActiveTab (no modifier needed)", () => {
    expect(matchGlobalKey(ev("F2"))).toEqual({
      handler: "renameActiveTab",
      preventDefault: true,
    });
  });

  it("Cmd+Shift+L dispatches togglePinActiveTab", () => {
    expect(matchGlobalKey(ev("l", { meta: true, shift: true }))).toEqual({
      handler: "togglePinActiveTab",
      preventDefault: true,
    });
    // Plain Cmd+L stays free for editor link insertion / etc.
    expect(matchGlobalKey(ev("l", { meta: true }))).toBeNull();
  });

  it("Cmd+Opt+1..8 takes precedence over plain Cmd+1..8 (the chord wins, not the digit)", () => {
    // The matcher branches on alt before falling into the Cmd+1..9
    // tab branch — Cmd+Opt+3 is "go to People" not "switch to tab 3".
    expect(matchGlobalKey(ev("3", { meta: true, alt: true }))?.handler).toBe(
      "setSurface",
    );
    expect(matchGlobalKey(ev("3", { meta: true }))?.handler).toBe(
      "switchToTab",
    );
  });
});
