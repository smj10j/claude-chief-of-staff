/**
 * Regression test for the Cmd+T / Cmd+W conflict between the console's
 * own tab strip and the app-global tab shortcuts (state/keys.ts).
 *
 * Two keydown listeners live on `window`: the global one (bubble phase,
 * Shell.handleNewTab → new *workspace* tab on Home) and the console's
 * own (ChatHost). Before the fix both fired for a console Cmd+T, and the
 * new Home workspace tab won the visible surface — so Cmd+T looked like
 * it opened a Home tab instead of a new session.
 *
 * ChatHost now listens in the capture phase and calls
 * stopImmediatePropagation for the chords it owns, which runs before —
 * and preempts — the global bubble-phase handler. These tests stand in a
 * bubble-phase listener for the global handler and assert it is preempted
 * for owned chords (Cmd+T / Cmd+W) but not for others (Cmd+P).
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetInvokeMock, setInvokeHandlers } from "../test/invokeMock";
import { _resetTabs, getTabIds } from "../state/chatSession";
import { Console } from "./Console";

beforeEach(() => {
  resetInvokeMock();
  _resetTabs();
  window.localStorage.clear();
  setInvokeHandlers({
    chat_slash_commands: () => [],
    chat_replay: () => [],
  });
});

afterEach(() => {
  resetInvokeMock();
  _resetTabs();
  window.localStorage.clear();
});

describe("Console keyboard shortcuts", () => {
  it("Cmd+T opens a new console tab and preempts the global handler", async () => {
    // Stand-in for the app-global bubble-phase keydown handler.
    const global = vi.fn();
    window.addEventListener("keydown", global);
    try {
      render(<Console />);
      // Wait for the fallback starter tab so the strip has mounted.
      await waitFor(() =>
        expect(screen.getByText("new session")).toBeInTheDocument(),
      );
      const before = getTabIds().length;

      // Dispatch from a descendant so the window capture-phase listener
      // (ChatHost) runs before the window bubble-phase one (`global`).
      fireEvent.keyDown(document.body, { key: "t", metaKey: true });

      expect(getTabIds().length).toBe(before + 1);
      expect(global).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", global);
    }
  });

  it("lets non-owned chords (Cmd+P) fall through to the global handler", async () => {
    const global = vi.fn();
    window.addEventListener("keydown", global);
    try {
      render(<Console />);
      await waitFor(() =>
        expect(screen.getByText("new session")).toBeInTheDocument(),
      );
      const before = getTabIds().length;

      fireEvent.keyDown(document.body, { key: "p", metaKey: true });

      // Console didn't swallow it: no new tab, and the global handler ran.
      expect(getTabIds().length).toBe(before);
      expect(global).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", global);
    }
  });
});
