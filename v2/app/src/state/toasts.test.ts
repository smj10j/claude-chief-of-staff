// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  dismissToast,
  showToast,
  TOAST_DISMISS_EVENT,
  TOAST_SHOW_EVENT,
  type Toast,
} from "./toasts";

afterEach(() => {
  vi.useRealTimers();
});

describe("showToast / dismissToast", () => {
  it("fires TOAST_SHOW_EVENT with a generated id", () => {
    const events: Toast[] = [];
    const handler = (e: Event) =>
      events.push((e as CustomEvent<Toast>).detail);
    window.addEventListener(TOAST_SHOW_EVENT, handler);
    const id = showToast({ kind: "info", text: "hello" });
    window.removeEventListener(TOAST_SHOW_EVENT, handler);

    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(id);
    expect(events[0].text).toBe("hello");
    expect(events[0].kind).toBe("info");
  });

  it("preserves the action callback through the event", () => {
    const onClick = vi.fn();
    let captured: Toast | undefined;
    const handler = (e: Event) => {
      captured = (e as CustomEvent<Toast>).detail;
    };
    window.addEventListener(TOAST_SHOW_EVENT, handler);
    showToast({
      kind: "success",
      text: "saved",
      action: { label: "Undo", onClick },
      durationMs: 3000,
    });
    window.removeEventListener(TOAST_SHOW_EVENT, handler);

    expect(captured?.action?.label).toBe("Undo");
    captured?.action?.onClick();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("dismissToast fires TOAST_DISMISS_EVENT with the id", () => {
    const ids: string[] = [];
    const handler = (e: Event) =>
      ids.push((e as CustomEvent<{ id: string }>).detail.id);
    window.addEventListener(TOAST_DISMISS_EVENT, handler);
    dismissToast("abc");
    window.removeEventListener(TOAST_DISMISS_EVENT, handler);

    expect(ids).toEqual(["abc"]);
  });

  it("each showToast call produces a unique id", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 25; i++) {
      ids.add(showToast({ kind: "info", text: String(i) }));
    }
    expect(ids.size).toBe(25);
  });
});
