/**
 * HtmlEditor component + helper tests.
 *
 * Coverage focus:
 *   - Pure helpers: clampPct (default / bounds / NaN fallback).
 *   - Component chrome that renders without CodeMirror — loading,
 *     error, header, view-mode toggle, divider, save-status pill.
 *   - Persistence reads/writes for view mode (sessionStorage) and
 *     split ratio (localStorage).
 *   - Iframe security posture: sandbox attribute and instrumented
 *     srcDoc payload. CodeMirror's view itself isn't exercised
 *     because the dynamic import doesn't resolve in happy-dom — its
 *     mount lives behind a useEffect and is independent of the
 *     chrome we test here.
 */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  invokeMockFn,
  resetInvokeMock,
  setInvokeHandlers,
} from "../test/invokeMock";
import {
  AUTOSAVE_DEBOUNCE_MS,
  clampPct,
  HtmlEditor,
  SPLIT_DEFAULT_PCT,
  SPLIT_KEY,
  SPLIT_MAX_PCT,
  SPLIT_MIN_PCT,
} from "./HtmlEditor";

const REL = "projects/demo/index.html";
const SAMPLE_HTML = `<!DOCTYPE html>
<html><body><h1>hi</h1><p>world</p></body></html>`;

function setupRead(opts?: { html?: string; bytes?: number }): void {
  setInvokeHandlers({
    content_read_file: () => ({
      rel_path: REL,
      markdown: opts?.html ?? SAMPLE_HTML,
      bytes: opts?.bytes ?? (opts?.html ?? SAMPLE_HTML).length,
    }),
  });
}

beforeEach(() => {
  resetInvokeMock();
  // Both stores are global — reset between tests so persistence
  // assertions aren't sensitive to suite ordering.
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  resetInvokeMock();
});

describe("clampPct", () => {
  it("returns 50 when given a non-finite input", () => {
    expect(clampPct(Number.NaN)).toBe(SPLIT_DEFAULT_PCT);
    expect(clampPct(Number.POSITIVE_INFINITY)).toBe(SPLIT_DEFAULT_PCT);
  });

  it("passes values inside the [min, max] range through unchanged", () => {
    expect(clampPct(50)).toBe(50);
    expect(clampPct(20)).toBe(20);
    expect(clampPct(80)).toBe(80);
  });

  it("clamps below the floor up to SPLIT_MIN_PCT", () => {
    expect(clampPct(0)).toBe(SPLIT_MIN_PCT);
    expect(clampPct(-100)).toBe(SPLIT_MIN_PCT);
    expect(clampPct(SPLIT_MIN_PCT - 0.001)).toBe(SPLIT_MIN_PCT);
  });

  it("clamps above the ceiling down to SPLIT_MAX_PCT", () => {
    expect(clampPct(100)).toBe(SPLIT_MAX_PCT);
    expect(clampPct(9999)).toBe(SPLIT_MAX_PCT);
    expect(clampPct(SPLIT_MAX_PCT + 0.001)).toBe(SPLIT_MAX_PCT);
  });
});

describe("HtmlEditor — load states", () => {
  it("shows a loading state before content_read_file resolves", () => {
    let resolveLoad: (value: unknown) => void = () => undefined;
    setInvokeHandlers({
      content_read_file: () =>
        new Promise((resolve) => {
          resolveLoad = resolve;
        }),
    });
    render(<HtmlEditor relPath={REL} label="demo" onClose={() => {}} />);
    expect(screen.getByText(/loading document/i)).toBeInTheDocument();
    // Resolve the pending promise so the test cleans up cleanly
    // (otherwise React logs an "unmounted but state updated" warning
    // during teardown, which the strict-console hook fails on).
    resolveLoad({ rel_path: REL, markdown: SAMPLE_HTML, bytes: 1 });
  });

  it("shows an error state when content_read_file rejects", async () => {
    setInvokeHandlers({
      content_read_file: () => {
        throw new Error("file not found");
      },
    });
    render(<HtmlEditor relPath={REL} label="demo" onClose={() => {}} />);
    expect(
      await screen.findByText(/could not read.*file not found/i),
    ).toBeInTheDocument();
  });

  it("renders the header label and rel-path after a successful load", async () => {
    setupRead();
    render(<HtmlEditor relPath={REL} label="Demo HTML" onClose={() => {}} />);
    expect(await screen.findByText("Demo HTML")).toBeInTheDocument();
    expect(screen.getByText(REL)).toBeInTheDocument();
  });
});

describe("HtmlEditor — view mode", () => {
  it("defaults to split mode and exposes both toggle buttons", async () => {
    setupRead();
    const { container } = render(
      <HtmlEditor relPath={REL} label="demo" onClose={() => {}} />,
    );
    await screen.findByText("demo");
    const split = screen.getByRole("button", { name: /split/i });
    const preview = screen.getByRole("button", { name: /preview/i });
    expect(split).toHaveAttribute("aria-pressed", "true");
    expect(preview).toHaveAttribute("aria-pressed", "false");
    expect(container.querySelector(".cos-html-shell.mode-split")).not.toBeNull();
  });

  it("switches to preview mode and persists the choice to sessionStorage", async () => {
    setupRead();
    const { container } = render(
      <HtmlEditor relPath={REL} label="demo" onClose={() => {}} />,
    );
    await screen.findByText("demo");
    fireEvent.click(screen.getByRole("button", { name: /preview/i }));
    expect(
      container.querySelector(".cos-html-shell.mode-preview"),
    ).not.toBeNull();
    expect(
      window.sessionStorage.getItem(`cos.html-view-mode.${REL}`),
    ).toBe("preview");
  });

  it("reads the saved view mode from sessionStorage on mount", async () => {
    window.sessionStorage.setItem(`cos.html-view-mode.${REL}`, "preview");
    setupRead();
    const { container } = render(
      <HtmlEditor relPath={REL} label="demo" onClose={() => {}} />,
    );
    await screen.findByText("demo");
    expect(
      container.querySelector(".cos-html-shell.mode-preview"),
    ).not.toBeNull();
  });
});

describe("HtmlEditor — split divider", () => {
  it("renders the divider with separator role + ARIA bounds", async () => {
    setupRead();
    render(<HtmlEditor relPath={REL} label="demo" onClose={() => {}} />);
    await screen.findByText("demo");
    const handle = screen.getByRole("separator", {
      name: /resize source/i,
    });
    expect(handle).toHaveAttribute("aria-orientation", "vertical");
    expect(handle).toHaveAttribute(
      "aria-valuemin",
      String(SPLIT_MIN_PCT),
    );
    expect(handle).toHaveAttribute(
      "aria-valuemax",
      String(SPLIT_MAX_PCT),
    );
    expect(handle).toHaveAttribute(
      "aria-valuenow",
      String(SPLIT_DEFAULT_PCT),
    );
  });

  it("loads a saved split ratio from localStorage on mount", async () => {
    window.localStorage.setItem(SPLIT_KEY, "62");
    setupRead();
    render(<HtmlEditor relPath={REL} label="demo" onClose={() => {}} />);
    await screen.findByText("demo");
    const handle = screen.getByRole("separator", {
      name: /resize source/i,
    });
    expect(handle).toHaveAttribute("aria-valuenow", "62");
  });

  it("clamps an out-of-bounds saved ratio back into the legal range", async () => {
    window.localStorage.setItem(SPLIT_KEY, "999");
    setupRead();
    render(<HtmlEditor relPath={REL} label="demo" onClose={() => {}} />);
    await screen.findByText("demo");
    const handle = screen.getByRole("separator", {
      name: /resize source/i,
    });
    expect(handle).toHaveAttribute("aria-valuenow", String(SPLIT_MAX_PCT));
  });

  it("ArrowRight steps the ratio up by 2 and persists to localStorage", async () => {
    setupRead();
    render(<HtmlEditor relPath={REL} label="demo" onClose={() => {}} />);
    await screen.findByText("demo");
    const handle = screen.getByRole("separator", {
      name: /resize source/i,
    });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle).toHaveAttribute(
      "aria-valuenow",
      String(SPLIT_DEFAULT_PCT + 2),
    );
    await waitFor(() =>
      expect(window.localStorage.getItem(SPLIT_KEY)).toBe(
        String(SPLIT_DEFAULT_PCT + 2),
      ),
    );
  });

  it("Shift+ArrowLeft steps by 8 and respects the lower bound", async () => {
    window.localStorage.setItem(SPLIT_KEY, String(SPLIT_MIN_PCT + 4));
    setupRead();
    render(<HtmlEditor relPath={REL} label="demo" onClose={() => {}} />);
    await screen.findByText("demo");
    const handle = screen.getByRole("separator", {
      name: /resize source/i,
    });
    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    // 19 - 8 = 11 → clamped to 15.
    expect(handle).toHaveAttribute("aria-valuenow", String(SPLIT_MIN_PCT));
  });
});

describe("HtmlEditor — iframe security + payload", () => {
  it("renders the preview iframe with sandbox=allow-scripts", async () => {
    setupRead();
    const { container } = render(
      <HtmlEditor relPath={REL} label="demo" onClose={() => {}} />,
    );
    await screen.findByText("demo");
    const frame = container.querySelector("iframe");
    expect(frame).not.toBeNull();
    // omit allow-same-origin: keeps the iframe in an opaque origin so
    // it can't reach the parent's localStorage / cookies even though
    // scripts run for designed-page interactivity.
    expect(frame!.getAttribute("sandbox")).toBe("allow-scripts");
  });

  it("instruments the srcDoc with data-cos-src-line + bridge script", async () => {
    setupRead();
    const { container } = render(
      <HtmlEditor relPath={REL} label="demo" onClose={() => {}} />,
    );
    await screen.findByText("demo");
    const frame = container.querySelector("iframe") as HTMLIFrameElement;
    const srcDoc = frame.getAttribute("srcdoc") ?? "";
    expect(srcDoc).toContain('data-cos-src-line="2"'); // <html ...>
    expect(srcDoc).toContain("cos-html-click");
  });
});

describe("HtmlEditor — relPath swap (cross-file save guard)", () => {
  // Regression coverage for the bug fixed in 6cb8b71: under React 18
  // concurrent reconciliation, an outgoing editor's dirty-flush could
  // write to the wrong file because relPath mutated mid-cleanup. The
  // fix has two pieces — `key={relPath}` on the inner editor (forces
  // full remount on swap) and `useRef(relPath)` *without* reassignment
  // inside the inner editor. We can structurally verify the first; the
  // second is enforced by the absence of a reassignment statement,
  // which can't be tested directly. The deeper "save targets old file"
  // path runs through CodeMirror's update listener, which doesn't
  // execute in happy-dom — that needs an e2e harness, tracked in the
  // 2026-05-07 polish-pass audit (T1.3).
  it("re-fetches the file when relPath changes", async () => {
    const REL_A = "projects/a/index.html";
    const REL_B = "projects/b/index.html";
    setInvokeHandlers({
      content_read_file: ({ relPath }: any) => ({
        rel_path: relPath,
        markdown: `<html><body>${relPath}</body></html>`,
        bytes: 32,
      }),
    });
    const { rerender } = render(
      <HtmlEditor relPath={REL_A} label="A" onClose={() => {}} />,
    );
    await screen.findByText(REL_A);
    const readsForA = invokeMockFn.mock.calls.filter(
      (c) => c[0] === "content_read_file" && (c[1] as any)?.relPath === REL_A,
    ).length;
    expect(readsForA).toBeGreaterThanOrEqual(1);

    rerender(<HtmlEditor relPath={REL_B} label="B" onClose={() => {}} />);
    await screen.findByText(REL_B);
    const readsForB = invokeMockFn.mock.calls.filter(
      (c) => c[0] === "content_read_file" && (c[1] as any)?.relPath === REL_B,
    ).length;
    expect(readsForB).toBeGreaterThanOrEqual(1);
  });

  it("never writes the new relPath while loading after a swap", async () => {
    // If `key={relPath}` were dropped, React would reuse the inner
    // LoadedHtmlEditor instance and its baselineRef/dirtyRef across
    // files. A subsequent unmount-flush could then post the previous
    // file's HTML to the new relPath. The guard: verify no
    // content_write_file fires across a clean swap.
    const REL_A = "projects/a/index.html";
    const REL_B = "projects/b/index.html";
    setInvokeHandlers({
      content_read_file: ({ relPath }: any) => ({
        rel_path: relPath,
        markdown: `<html><body>${relPath}</body></html>`,
        bytes: 32,
      }),
    });
    const { rerender, unmount } = render(
      <HtmlEditor relPath={REL_A} label="A" onClose={() => {}} />,
    );
    await screen.findByText(REL_A);
    rerender(<HtmlEditor relPath={REL_B} label="B" onClose={() => {}} />);
    await screen.findByText(REL_B);
    unmount();
    const writes = invokeMockFn.mock.calls.filter(
      (c) => c[0] === "content_write_file",
    );
    expect(writes).toHaveLength(0);
  });
});

describe("HtmlEditor — autosave constants", () => {
  // Locks the documented debounce value. The full debounce path runs
  // via CodeMirror's update listener, which doesn't execute in
  // happy-dom; deeper tests for "rapid edits coalesce", "Cmd-S
  // flushes pending", and "unmount flushes pending" need an e2e
  // harness — tracked in the 2026-05-07 polish-pass audit (T1.4).
  it("AUTOSAVE_DEBOUNCE_MS is 2000ms", () => {
    expect(AUTOSAVE_DEBOUNCE_MS).toBe(2000);
  });
});

describe("HtmlEditor — save status pill", () => {
  it("listens to cos:save-state events filtered by relPath", async () => {
    setupRead();
    // Count listeners attached for the save event so we can wait
    // until SaveStatusPill's useEffect has actually committed before
    // dispatching. happy-dom + React 19 can defer passive effects
    // past the initial render flush, which would otherwise race with
    // the dispatch and leave us asserting against a stale tree.
    let saveListenerCount = 0;
    const origAdd = window.addEventListener.bind(window);
    const origRemove = window.removeEventListener.bind(window);
    window.addEventListener = function (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ): void {
      if (type === "cos:save-state") saveListenerCount++;
      origAdd(type, listener, options);
    } as typeof window.addEventListener;
    window.removeEventListener = function (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ): void {
      if (type === "cos:save-state") saveListenerCount--;
      origRemove(type, listener, options);
    } as typeof window.removeEventListener;
    render(<HtmlEditor relPath={REL} label="demo" onClose={() => {}} />);
    await screen.findByText("demo");
    expect(screen.getByText(/ready/i)).toBeInTheDocument();
    await waitFor(() =>
      expect(saveListenerCount).toBeGreaterThan(0),
    );

    // Mismatched relPath — pill should NOT change. Filter by relPath
    // is the key behavior we're locking in so a stale DocEditor mount
    // can't bleed status into our pill.
    act(() => {
      window.dispatchEvent(
        new CustomEvent("cos:save-state", {
          detail: {
            relPath: "some/other/file.html",
            dirty: true,
            state: { kind: "saving" },
            lastSavedAt: null,
          },
        }),
      );
    });
    expect(screen.queryByText(/saving/i)).toBeNull();

    // Matching relPath — pill should re-render with "saving…".
    act(() => {
      window.dispatchEvent(
        new CustomEvent("cos:save-state", {
          detail: {
            relPath: REL,
            dirty: true,
            state: { kind: "saving" },
            lastSavedAt: null,
          },
        }),
      );
    });
    await waitFor(() =>
      expect(
        document.querySelector(".cos-pill-chip")?.textContent,
      ).toMatch(/saving/i),
    );
  });
});
