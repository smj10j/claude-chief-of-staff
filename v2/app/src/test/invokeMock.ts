import { vi, type Mock } from "vitest";

/**
 * Per-test routing for Tauri `invoke` calls. Each test can register
 * handlers for specific commands; anything unhandled returns the
 * default value or rejects, so a missing mock is loud rather than
 * silently returning `undefined`.
 *
 * Usage:
 *   import { setInvokeHandlers, resetInvokeMock } from "../test/invokeMock";
 *   beforeEach(() => resetInvokeMock());
 *   it("renders", async () => {
 *     setInvokeHandlers({
 *       content_list_meetings: () => [{ slug: "a", label: "A", ... }],
 *     });
 *     render(<Surface />);
 *   });
 */

type InvokeHandler = (args: Record<string, unknown> | undefined) => unknown;

let handlers: Record<string, InvokeHandler> = {};
let defaultHandler: InvokeHandler | null = null;

export function setInvokeHandlers(map: Record<string, InvokeHandler>): void {
  handlers = { ...handlers, ...map };
}

export function setInvokeDefault(handler: InvokeHandler | null): void {
  defaultHandler = handler;
}

export function resetInvokeMock(): void {
  handlers = {};
  defaultHandler = null;
  invokeMockFn.mockClear();
}

export const invokeMockFn: Mock = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
  const handler = handlers[cmd] ?? defaultHandler;
  if (!handler) {
    // Loud failure mode: unhandled commands surface in test output as
    // a clear error so we don't accidentally rely on undefined.
    throw new Error(`unmocked Tauri command: ${cmd}`);
  }
  return handler(args);
});

export const mockInvokeImpl = invokeMockFn;
