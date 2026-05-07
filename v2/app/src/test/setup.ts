import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// Global Tauri mocks. Surface tests fall through to these defaults
// unless they install their own per-test handler via `mockInvoke()`.
// Keeping them here means individual tests can stay focused on the
// behavior under test rather than rebuilding the IPC stub each time.
vi.mock("@tauri-apps/api/core", async () => {
  const { mockInvokeImpl } = await import("./invokeMock");
  return {
    invoke: mockInvokeImpl,
  };
});

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(true),
  requestPermission: vi.fn().mockResolvedValue("granted"),
  sendNotification: vi.fn(),
}));

// React surfaces render errors via console.error before swallowing
// them with the nearest error boundary. Without this hook, a smoke
// test could "pass" while the production app blanks. Capture every
// console.error during a test and fail the test if anything got
// logged that wasn't explicitly allowed via `allowConsoleError`.
const consoleErrorSpy = vi.spyOn(console, "error");
let allowedConsoleErrors: RegExp[] = [];

beforeEach(() => {
  consoleErrorSpy.mockClear();
  allowedConsoleErrors = [];
});

afterEach(() => {
  cleanup();
  const calls = consoleErrorSpy.mock.calls;
  const offending = calls.filter(([first]) => {
    const text = typeof first === "string" ? first : String(first);
    return !allowedConsoleErrors.some((pat) => pat.test(text));
  });
  if (offending.length > 0) {
    const summary = offending
      .map((args) => args.map((a) => String(a)).join(" "))
      .join("\n  ");
    expect.fail(
      `console.error fired during test (failing). Allow with allowConsoleError().\n  ${summary}`,
    );
  }
});

/** Tests that intentionally trigger a React error boundary or expect
 *  a known console.error can opt-out with this helper. */
export function allowConsoleError(...patterns: RegExp[]): void {
  allowedConsoleErrors.push(...patterns);
}
