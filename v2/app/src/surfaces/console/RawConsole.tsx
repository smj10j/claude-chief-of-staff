/**
 * PRD-116 Console — embedded `claude` session.
 *
 * Solo-dev cut: raw PTY mode only. The Rust side spawns the user's
 * local `claude` binary inside a portable-pty pseudoterminal; we render
 * its output through xterm.js and pipe keystrokes back. Stream-json
 * chat mode and transcript persistence land in subsequent commits.
 *
 * Persistence across surface navigation: the live xterm instance, its
 * fit addon, and the Tauri event subscriptions are hoisted into a
 * module-level store (`state/consoleSession.ts`) so when the user
 * navigates to People/Tasks/etc. and back, the session is still
 * running and the scrollback is intact. PRD §4.3.1.
 *
 * Lifecycle (component perspective):
 *   - mount: if the store has an active session, re-attach the term
 *     to the new container element and use it; otherwise show the
 *     empty state with a "start session" CTA.
 *   - "start session": spawn PTY → create term → store both in the
 *     module singleton → attach to container.
 *   - unmount (surface change): detach the term DOM, but DO NOT close
 *     the PTY or dispose listeners. Output keeps streaming into the
 *     scrollback while the user is on another surface.
 *   - "stop session": send cancel + close, dispose the term + store.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Play, Square, Terminal as TerminalIcon } from "lucide-react";

import {
  disposeActiveSession,
  getActiveSession,
  markExited,
  setActiveSession,
  subscribe,
  type ConsoleSession,
} from "../../state/consoleSession";

type Mode = "raw" | "chat";

type OpenResult = {
  handle: string;
  mode: Mode;
  binary_path: string;
  cwd: string;
  argv: string[];
};

type LocalState =
  | { kind: "starting" }
  | { kind: "error"; message: string };

export function RawConsole() {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Subscribe to the singleton store so a session that finished while
  // the user was on a different surface re-renders the "ended" banner
  // when they come back. useSyncExternalStore is the React-19 way to
  // hook a non-React store into the render cycle.
  const session = useSyncExternalStore(subscribe, getActiveSession, () =>
    null,
  );

  // Local state for the bits that don't live in the singleton: the
  // "currently spawning" + error states, both of which are scoped to
  // a single user click.
  const [localState, setLocalState] = useState<LocalState | null>(null);

  // On mount: if a session exists in the store, attach its term to
  // our container. On unmount: detach the term DOM but leave the
  // session alive in the store so a return visit picks back up.
  //
  // First-time mount is the load-bearing case: startSession() now
  // creates the Terminal but does NOT call .open() — we wait until
  // this effect runs against a container that's already CSS-visible
  // (`session` flips to non-null *before* this effect fires, which
  // flips the `is-hidden` class off). xterm's renderer needs real
  // pixel dimensions, so opening on a `display: none` host produces
  // a zero-dim canvas that never recovers.
  //
  // Re-mount after navigating away is the second load-bearing case.
  // xterm's `open()` is *not* safe to call a second time on a
  // different container — the canvas renderer keeps a stale viewport
  // and the next paint comes up blank. So we open exactly once and
  // for subsequent mounts just `appendChild` the existing element
  // (which auto-detaches from the previous parent), then call
  // `term.refresh()` to force a redraw against the new viewport.
  useEffect(() => {
    if (!session || !containerRef.current) return;
    const container = containerRef.current;
    type TermLike = {
      element?: HTMLElement;
      rows: number;
      open: (el: HTMLElement) => void;
      focus: () => void;
      refresh: (start: number, end: number) => void;
    };
    type FitLike = { fit: () => void };
    const term = session.term as TermLike;
    const fit = session.fit as FitLike;
    let firstMount = false;
    if (!term.element) {
      // First mount of this session — xterm hasn't been opened yet.
      term.open(container);
      firstMount = true;
    } else if (term.element.parentElement !== container) {
      // Returning to the surface after navigating away: migrate the
      // element. appendChild handles the detach-from-previous-parent
      // step for us.
      container.appendChild(term.element);
    }
    // Defer to the next frame so layout has measured the container.
    // Calling fit() in the same tick as open()/appendChild can race
    // and produce a 0-row terminal. On a re-mount we also force a
    // refresh — without this the canvas renderer keeps showing the
    // pre-detach buffer (or, more often, nothing at all).
    const raf = window.requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {
        // resize observer below will retry once the host stabilizes.
      }
      if (!firstMount) {
        try {
          term.refresh(0, Math.max(0, term.rows - 1));
        } catch {
          // best-effort; refresh can throw mid-resize
        }
      }
      term.focus();
    });
    return () => {
      window.cancelAnimationFrame(raf);
      // Detach but don't dispose. The store-level singleton keeps
      // the term and event listeners alive across the unmount.
      if (term.element && term.element.parentElement === container) {
        container.removeChild(term.element);
      }
    };
  }, [session]);

  // Resize observer: when the host div changes size (sidebar
  // collapse, side panel toggle, window resize), refit xterm and tell
  // the PTY about the new geometry so claude reflows long lines.
  useEffect(() => {
    if (!session) return;
    const host = containerRef.current;
    if (!host) return;
    type FitLike = { fit: () => void };
    type TermLike = { rows: number; cols: number };
    const fit = session.fit as FitLike;
    const term = session.term as TermLike;
    const refit = () => {
      try {
        fit.fit();
      } catch {
        return;
      }
      void invoke("console_resize", {
        handle: session.handle,
        rows: term.rows,
        cols: term.cols,
      }).catch(() => {});
    };
    const observer = new ResizeObserver(() => refit());
    observer.observe(host);
    refit();
    return () => observer.disconnect();
  }, [session]);

  const startSession = useCallback(async () => {
    // Already running or starting: ignore.
    if (session && !session.exited) return;
    if (localState?.kind === "starting") return;

    // If a finished session is sitting in the store, dispose it
    // before starting a new one — the "start again" CTA reads as
    // "fresh session" to the user.
    if (session && session.exited) {
      try {
        await invoke("console_close", { handle: session.handle });
      } catch {
        // best-effort
      }
      disposeActiveSession();
    }

    setLocalState({ kind: "starting" });
    try {
      // Lazy-load xterm + addon so the surface's first paint isn't
      // blocked on the ~150 KB minified bundle.
      const [{ Terminal }, { FitAddon }, _styles] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/xterm/css/xterm.css"),
      ]);
      const styles = window.getComputedStyle(document.documentElement);
      const bg = styles.getPropertyValue("--cos-surface-base").trim() || "#0b0d10";
      const fg = styles.getPropertyValue("--cos-content").trim() || "#e8e8ea";
      const accent =
        styles.getPropertyValue("--cos-accent").trim() || "#7aa2f7";

      const term = new Terminal({
        // xterm reads fontFamily as a literal CSS string but does NOT
        // resolve CSS vars — using `var(--…)` here falls through to a
        // proportional fallback, which breaks the column grid (every
        // redraw stacks because claude's cursor positioning assumes
        // every glyph is exactly one cell wide). Pin to a real
        // monospace stack instead.
        fontFamily: '"JetBrains Mono", Menlo, Monaco, "Courier New", monospace',
        fontSize: 13,
        // 1.2 line-height matches xterm's default for the canvas
        // renderer. Anything taller leaves vertical seams in the
        // box-drawing chars claude uses for separators.
        lineHeight: 1.2,
        cursorBlink: true,
        scrollback: 5000,
        // Don't translate \n to \r\n — claude already emits proper
        // CRLF; converting again produces double-newlines (visible
        // as duplicated blank lines on every redraw).
        convertEol: false,
        theme: {
          background: bg,
          foreground: fg,
          cursor: accent,
          selectionBackground: "rgba(122,162,247,0.32)",
        },
        allowProposedApi: true,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      // Note: we do NOT call term.open() here. The container is
      // currently `display: none` (session is still null), so opening
      // xterm against it produces a zero-dim canvas that never
      // recovers even after the container becomes visible. The
      // session-change useEffect above attaches the terminal once
      // the container is visible, after setActiveSession flips the
      // `is-hidden` class off.
      //
      // For the IPC we send xterm's default geometry (24×80); the
      // resize observer reconciles to the real container size on
      // the first frame after attach.

      // Open the PTY. Empty cwd → backend defaults to workspace root.
      // Empty model/permission_mode → backend inherits from
      // Settings → Claude (--model, --permission-mode, --effort, etc.).
      const open = await invoke<OpenResult>("console_open", {
        args: {
          cwd: "",
          mode: "raw",
          model: "",
          permission_mode: "",
          resume_id: "",
          rows: term.rows || 24,
          cols: term.cols || 80,
        },
      });

      // Wire incoming PTY bytes → xterm. Capture the unlisten so we
      // can tear down on session close.
      const dataUnlisten = await listen<string>(
        `console:${open.handle}:data`,
        (event) => {
          term.write(event.payload);
        },
      );
      const exitUnlisten = await listen<{ reason?: string }>(
        `console:${open.handle}:exit`,
        (event) => {
          markExited(event.payload?.reason);
        },
      );

      // Pipe typed keystrokes → PTY stdin. Note the closure captures
      // `open.handle` once, which is fine — handles never change for
      // a given session.
      term.onData((data: string) => {
        const bytes = new TextEncoder().encode(data);
        void invoke("console_send", {
          handle: open.handle,
          bytes: Array.from(bytes),
        }).catch(() => {
          // child likely exited; the exit event is about to fire.
        });
      });

      const next: ConsoleSession = {
        handle: open.handle,
        term,
        fit,
        meta: open,
        dataUnlisten,
        exitUnlisten,
        exited: false,
      };
      setActiveSession(next);
      setLocalState(null);
      term.focus();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setLocalState({ kind: "error", message });
    }
  }, [session, localState]);

  const stopSession = useCallback(async () => {
    if (!session) return;
    try {
      await invoke("console_cancel", { handle: session.handle });
    } catch {
      // best-effort
    }
  }, [session]);

  const endSession = useCallback(async () => {
    if (!session) return;
    try {
      await invoke("console_close", { handle: session.handle });
    } catch {
      // best-effort
    }
    disposeActiveSession();
  }, [session]);

  // Empty-state copy stays visible whenever there's no session — that
  // includes the "starting" sub-state, so the user has *something* to
  // look at while the backend spawns Claude (which can take a beat).
  // Once `session` flips to non-null the empty state is replaced by
  // the (now visible) terminal.
  const showEmptyState = !session;
  const isStarting = localState?.kind === "starting";
  const isRunning = session !== null && !session.exited;
  const isStopped = session !== null && session.exited;

  return (
    <div className="cos-console">
      <header className="cos-console-head">
        <div className="cos-console-head-title">
          <TerminalIcon size={16} strokeWidth={1.75} aria-hidden />
          <h1>Console</h1>
        </div>
        <div className="cos-console-chips">
          {session && (
            <>
              <span className="cos-chip" title={`Working dir: ${session.meta.cwd}`}>
                <span className="cos-chip-label">cwd</span>
                <span className="cos-chip-value">
                  {shortenPath(session.meta.cwd)}
                </span>
              </span>
              <span className="cos-chip" title="Pseudo-terminal mode">
                <span className="cos-chip-label">mode</span>
                <span className="cos-chip-value">raw</span>
              </span>
              {session.meta.argv.length > 0 && (
                <span
                  className="cos-chip"
                  title={`argv: ${session.meta.argv.join(" ")}`}
                >
                  <span className="cos-chip-label">args</span>
                  <span className="cos-chip-value">
                    {summarizeArgv(session.meta.argv)}
                  </span>
                </span>
              )}
            </>
          )}
        </div>
        <div className="cos-console-actions">
          {isRunning ? (
            <button
              type="button"
              className="cos-btn cos-btn-ghost"
              onClick={() => void stopSession()}
              title="Send Ctrl+C, then SIGKILL after 2s"
            >
              <Square size={14} strokeWidth={1.75} aria-hidden />
              stop
            </button>
          ) : isStarting ? (
            <span className="cos-console-status">starting…</span>
          ) : (
            <button
              type="button"
              className="cos-btn cos-btn-primary"
              onClick={() => void startSession()}
            >
              <Play size={14} strokeWidth={1.75} aria-hidden />
              {isStopped ? "start again" : "start session"}
            </button>
          )}
          {isStopped && (
            <button
              type="button"
              className="cos-btn cos-btn-ghost"
              onClick={() => void endSession()}
              title="Discard the ended session"
            >
              dismiss
            </button>
          )}
        </div>
      </header>

      {showEmptyState && (
        <div className="cos-console-empty">
          <p className="cos-section-lede">
            A direct Claude Code session inside the app — same{" "}
            <code>claude</code> binary, same <code>CLAUDE.md</code>, same
            skills. Use it for the long tail of work that doesn't fit
            the curated surfaces.
          </p>
          <ul className="cos-helper-list">
            <li>
              Slash commands like <code>/morning-briefing</code>,{" "}
              <code>/prep-1on1 alice</code>, and plugin-namespaced
              commands work the same as in your terminal.
            </li>
            <li>
              The session inherits your Settings → Claude defaults
              (model, permission mode, effort) and runs against the
              workspace root, so <code>CLAUDE.md</code> resolves.
            </li>
            <li>
              Sessions keep running when you switch surfaces — your
              scrollback is here when you come back.
            </li>
            <li>
              <strong>Stop</strong> sends Ctrl+C and force-kills after a
              2-second grace.
            </li>
          </ul>
          <p className="cos-helper-text">
            Chat mode (structured turns, inline tool cards, transcript
            persistence) is the next milestone — this surface ships
            today as a real terminal.
          </p>
        </div>
      )}

      {localState?.kind === "error" && (
        <div className="cos-console-error" role="alert">
          <strong>Couldn't start a session.</strong>
          <p>{localState.message}</p>
          <button
            type="button"
            className="cos-btn"
            onClick={() => setLocalState(null)}
          >
            try again
          </button>
        </div>
      )}

      {isStopped && (
        <div className="cos-console-status-banner" role="status">
          Session ended
          {session?.exitReason ? ` (${session.exitReason})` : ""}.
        </div>
      )}

      {/*
       * The xterm host is always rendered (not gated on session state)
       * so the ResizeObserver and ref are stable across surface
       * remounts. Visibility is toggled via CSS so the empty-state
       * copy sits above an invisible terminal until the user starts.
       */}
      <div
        ref={containerRef}
        className={`cos-console-term ${
          session ? "is-visible" : "is-hidden"
        }`}
        aria-label="Claude Code terminal"
      />
    </div>
  );
}

/**
 * Trim a path to the last two segments so the chip stays compact.
 * "/Users/example.user/code/example/repo" → "example/repo".
 */
function shortenPath(p: string): string {
  if (!p) return "";
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 2) return parts.join("/");
  return parts.slice(-2).join("/");
}

/**
 * Compress a long argv into a chip-sized summary. Picks the value
 * after `--model`, `--permission-mode`, `--effort` and renders them
 * as `opus · auto · xhigh` so the user can see at a glance what the
 * inherited config looks like. Tooltip on the chip shows the full
 * argv.
 */
function summarizeArgv(argv: string[]): string {
  const pick = (flag: string): string | null => {
    const idx = argv.indexOf(flag);
    return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : null;
  };
  const parts = [
    pick("--model"),
    pick("--permission-mode"),
    pick("--effort"),
  ].filter((x): x is string => x !== null);
  return parts.length > 0 ? parts.join(" · ") : `${argv.length} args`;
}
