/**
 * Regression test for the console-session restore race (PRD-116 §4.5).
 *
 * The store-level test (`chatSession.test.ts`) proves `rehydrateTabs`
 * works when called on an empty store — but the real app mounts a
 * parent (`Console`) and a child (`ChatHost`), and React fires child
 * effects before parent effects. When rehydration lived in the parent
 * and the "ensure one tab" fallback lived in the child, the child's
 * `createTab()` ran first, tripped `rehydrateTabs`'s `tabs.size > 0`
 * guard, and every persisted session was silently dropped.
 *
 * This test mounts the real surface with a persisted ghost tab and
 * asserts the restored tab wins over the fresh starter — the exact
 * cold-start path that used to fail.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetInvokeMock, setInvokeHandlers } from "../test/invokeMock";
import { _resetTabs } from "../state/chatSession";
import { Console } from "./Console";

const PERSIST_KEY = "cos.console.tabs.v1";

beforeEach(() => {
  resetInvokeMock();
  _resetTabs();
  window.localStorage.clear();
  // ChatView fetches these on mount; a ghost tab needs no `listen`.
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

describe("Console tab restore on mount", () => {
  it("restores a persisted ghost tab instead of a fresh starter", async () => {
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        tabs: [
          {
            tabId: "t-restored-1",
            label: "quarterly planning notes",
            cwd: "",
            resumeHint: {
              sessionId: "sess-1",
              transcriptMdRel: "areas/console-sessions/sessions/x.md",
            },
          },
        ],
        activeTabId: "t-restored-1",
      }),
    );

    render(<Console />);

    // The restored tab's label must show in the strip...
    await waitFor(() =>
      expect(
        screen.getByText("quarterly planning notes"),
      ).toBeInTheDocument(),
    );
    // ...and no fresh "new session" starter tab was created in its place.
    expect(screen.queryByText("new session")).not.toBeInTheDocument();
  });

  it("still creates a starter tab when nothing was persisted", async () => {
    render(<Console />);
    await waitFor(() =>
      expect(screen.getByText("new session")).toBeInTheDocument(),
    );
  });
});
