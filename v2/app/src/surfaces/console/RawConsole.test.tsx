/**
 * RawConsole surface smoke test. We exercise the idle (empty) state
 * and the start-session error path; the actual PTY interaction lives
 * behind `console_open` and isn't reachable inside happy-dom.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetInvokeMock, setInvokeHandlers } from "../../test/invokeMock";
import { RawConsole } from "./RawConsole";

beforeEach(() => {
  resetInvokeMock();
});

afterEach(() => {
  resetInvokeMock();
});

describe("RawConsole surface", () => {
  it("renders the empty state with a 'start session' CTA", () => {
    render(<RawConsole />);
    expect(
      screen.getByRole("heading", { name: /^console$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /start session/i }),
    ).toBeInTheDocument();
  });

  it("surfaces a backend error when console_open rejects", async () => {
    setInvokeHandlers({
      console_open: () => {
        throw new Error("claude binary not found");
      },
    });
    render(<RawConsole />);
    fireEvent.click(screen.getByRole("button", { name: /start session/i }));
    await waitFor(() => {
      expect(
        screen.getByText(/couldn't start a session/i),
      ).toBeInTheDocument();
    });
    expect(screen.getByText(/claude binary not found/i)).toBeInTheDocument();
    // Try again resets to idle and shows the CTA again.
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(
      await screen.findByRole("button", { name: /start session/i }),
    ).toBeInTheDocument();
  });
});
