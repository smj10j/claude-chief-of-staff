import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, Columns2, Eye } from "lucide-react";

import "./editor.css";
import "./html-editor.css";
import { showToast } from "../state/toasts";
import { time } from "../state/perf";
import { instrumentHtmlForPreview } from "./htmlInstrument";

// Exported so tests can lock the documented value. The full debounce
// path runs via CodeMirror's update listener which doesn't execute in
// happy-dom; deeper coverage needs an e2e harness.
export const AUTOSAVE_DEBOUNCE_MS = 2000;
const PREVIEW_DEBOUNCE_MS = 200;
// Cursor → preview sync. Faster than the disk-save debounce so the
// preview tracks active cursor moves, but slow enough to skip the
// intermediate states of a multi-key navigation (arrows, page-down).
const CURSOR_SYNC_DEBOUNCE_MS = 80;
// Source/preview split — persisted globally (the user generally wants
// the same split across files). Bounds keep either pane from
// collapsing below readable width. Constants and clamper are exported
// for unit tests; nothing else in the app should reach in.
export const SPLIT_KEY = "cos.html-split-pct.v1";
export const SPLIT_DEFAULT_PCT = 50;
export const SPLIT_MIN_PCT = 15;
export const SPLIT_MAX_PCT = 85;

export function clampPct(n: number): number {
  if (!Number.isFinite(n)) return SPLIT_DEFAULT_PCT;
  return Math.max(SPLIT_MIN_PCT, Math.min(SPLIT_MAX_PCT, n));
}

type DocFile = {
  rel_path: string;
  // The backend field is named `markdown` for historical reasons, but
  // it carries the raw file text — works equally well for HTML.
  markdown: string;
  bytes: number;
};

type SaveResult = {
  rel_path: string;
  before_hash: string | null;
  after_hash: string;
  bytes: number;
  audit_id: number;
  skipped: boolean;
  git_tracked: boolean;
};

/**
 * Load state, pinned to the relPath it corresponds to. The `for`
 * field guards a cross-file save bug — see the equivalent comment
 * in DocEditor.tsx for the full mechanism. Short version: when the
 * editor's relPath prop changes (tab switch), the `load` state lags
 * one render behind, so without this guard a LoadedHtmlEditor would
 * briefly mount with the new relPath but the previous file's
 * content. CodeMirror's initial-content normalization can flip
 * dirtyRef=true and the unmount-cleanup then writes the wrong
 * content to the new path.
 */
type Load =
  | { kind: "loading"; for: string }
  | { kind: "ok"; for: string; doc: DocFile }
  | { kind: "error"; for: string; error: string };

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "error"; error: string };

type ViewMode = "split" | "preview";

type Props = {
  relPath: string;
  label: string;
  onClose: () => void;
};

// Save events ride the same global bus the markdown editor uses, so
// any future header chrome can listen once and stay agnostic about
// which editor is mounted. Per-relPath filtering avoids cross-talk.
const SAVE_EVENT = "cos:save-state";
type SavePayload = {
  relPath: string;
  dirty: boolean;
  state: SaveState;
  lastSavedAt: string | null;
};

function publishSaveState(payload: SavePayload) {
  window.dispatchEvent(
    new CustomEvent<SavePayload>(SAVE_EVENT, { detail: payload }),
  );
}

export function HtmlEditor({ relPath, label, onClose }: Props) {
  const [load, setLoad] = useState<Load>(() => ({
    kind: "loading",
    for: relPath,
  }));
  // Render-time guard: see the equivalent comment in DocEditor.tsx.
  // Resets load state synchronously when the relPath prop changes
  // so the renderer never mounts a LoadedHtmlEditor with stale
  // content from a prior path.
  if (load.for !== relPath) {
    setLoad({ kind: "loading", for: relPath });
  }

  useEffect(() => {
    let cancelled = false;
    setLoad({ kind: "loading", for: relPath });
    invoke<DocFile>("content_read_file", { relPath })
      .then((doc) => {
        if (!cancelled) setLoad({ kind: "ok", for: relPath, doc });
      })
      .catch((error) => {
        if (!cancelled)
          setLoad({ kind: "error", for: relPath, error: String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [relPath]);

  return (
    <div className="cos-doc cos-html-doc">
      <header className="cos-doc-header">
        <div className="cos-doc-crumb">
          <span className="cos-doc-label">{label}</span>
          <code className="cos-doc-path">{relPath}</code>
        </div>
        <div className="cos-doc-actions">
          {load.kind === "ok" && <SaveStatusPill relPath={relPath} />}
          <button
            type="button"
            className="cos-icon-btn"
            onClick={onClose}
            aria-label="Close document"
            title="Close · Esc"
          >
            <X size={16} strokeWidth={1.75} aria-hidden />
          </button>
        </div>
      </header>

      {(load.kind === "loading" || load.for !== relPath) && (
        <div className="cos-empty">Loading document…</div>
      )}
      {load.kind === "error" && load.for === relPath && (
        <div className="cos-empty cos-empty-error">
          Could not read: {load.error}
        </div>
      )}
      {load.kind === "ok" && load.for === relPath && (
        <LoadedHtmlEditor
          key={relPath}
          relPath={relPath}
          initialHtml={load.doc.markdown}
        />
      )}
    </div>
  );
}

function LoadedHtmlEditor({
  relPath,
  initialHtml,
}: {
  relPath: string;
  initialHtml: string;
}) {
  // ── view mode persistence ─────────────────────────────────────────
  // Per-doc so a strategy guide can stay in preview-only while a
  // smaller HTML scratch file is in split mode.
  const VIEW_KEY = `cos.html-view-mode.${relPath}`;
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      const saved = window.sessionStorage.getItem(VIEW_KEY);
      return saved === "preview" ? "preview" : "split";
    } catch {
      return "split";
    }
  });
  useEffect(() => {
    try {
      window.sessionStorage.setItem(VIEW_KEY, viewMode);
    } catch {
      /* private mode — view mode is session-only */
    }
  }, [VIEW_KEY, viewMode]);

  // ── split ratio (drag-resizable) ──────────────────────────────────
  // Persisted globally rather than per-doc — a user who likes a 60/40
  // split for HTML editing wants that split everywhere, not to re-tune
  // it on each file. Bounded to 15..85 % so neither pane can collapse
  // below readable width on a typical window.
  const [sourcePct, setSourcePct] = useState<number>(() => {
    try {
      const saved = window.localStorage.getItem(SPLIT_KEY);
      const n = saved ? parseFloat(saved) : NaN;
      if (Number.isFinite(n)) return clampPct(n);
    } catch {
      /* private mode — fall through to default */
    }
    return SPLIT_DEFAULT_PCT;
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(SPLIT_KEY, String(sourcePct));
    } catch {
      /* private mode — drag adjustments are session-only */
    }
  }, [sourcePct]);

  const panesRef = useRef<HTMLDivElement | null>(null);

  const onDividerPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Only react to primary-button presses; let the browser handle
      // right-click / middle-click for whatever it normally does.
      if (e.button !== 0) return;
      const container = panesRef.current;
      if (!container) return;
      e.preventDefault();
      // Snapshot the container rect at drag-start. Using a snapshot
      // (vs reading on every move) means a window resize mid-drag
      // doesn't cause the divider to lurch, and avoids a forced layout
      // on each pointermove.
      const rect = container.getBoundingClientRect();
      const onMove = (ev: PointerEvent) => {
        const x = ev.clientX - rect.left;
        const pct = (x / rect.width) * 100;
        setSourcePct(clampPct(pct));
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      // Lock cursor + suppress text selection across the whole window
      // for the duration of the drag — without this, hovering the
      // CodeMirror pane shows a text caret while dragging the
      // boundary, which feels broken.
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [],
  );

  const onDividerKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const step = e.shiftKey ? 8 : 2;
      const delta = e.key === "ArrowRight" ? step : -step;
      e.preventDefault();
      setSourcePct((prev) => clampPct(prev + delta));
    },
    [],
  );

  // ── save plumbing (mirrors DocEditor) ─────────────────────────────
  const baselineRef = useRef(initialHtml);
  const currentHtmlRef = useRef(initialHtml);
  const dirtyRef = useRef(false);
  const saveStateRef = useRef<SaveState>({ kind: "idle" });
  const lastSavedAtRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);
  // Pinned to mount-time relPath. See the equivalent comment in
  // DocEditor.tsx — reassigning on every render (the previous
  // `relPathRef.current = relPath`) opens a cross-file save bug under
  // React 18 concurrent reconciliation; an outgoing instance can be
  // speculatively re-rendered with the incoming relPath before unmount,
  // and the dirty-flush in cleanup then writes to the wrong file.
  const relPathRef = useRef(relPath);

  const publish = useCallback(() => {
    publishSaveState({
      relPath: relPathRef.current,
      dirty: dirtyRef.current,
      state: saveStateRef.current,
      lastSavedAt: lastSavedAtRef.current,
    });
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const runSave = useCallback(async () => {
    if (!dirtyRef.current) return;
    if (saveStateRef.current.kind === "saving") return;
    clearTimer();
    const html = currentHtmlRef.current;
    saveStateRef.current = { kind: "saving" };
    publish();
    try {
      // Same `content_write_file` IPC the markdown editor uses — the
      // backend field is called `markdown`, but the byte stream is
      // extension-agnostic. Audit + snapshot pipeline runs unchanged.
      await time("editor-input", () =>
        invoke<SaveResult>("content_write_file", {
          relPath: relPathRef.current,
          markdown: html,
        }),
      );
      baselineRef.current = html;
      dirtyRef.current = false;
      lastSavedAtRef.current = new Date().toISOString();
      saveStateRef.current = { kind: "idle" };
      publish();
    } catch (error) {
      const message = String(error);
      saveStateRef.current = { kind: "error", error: message };
      publish();
      const filename =
        relPathRef.current.split("/").pop() ?? relPathRef.current;
      showToast({
        kind: "error",
        text: `Couldn't save ${filename}: ${message}`,
        action: {
          label: "Retry",
          onClick: () => {
            saveStateRef.current = { kind: "idle" };
            publish();
            runSave();
          },
        },
        durationMs: 0,
      });
    }
  }, [clearTimer, publish]);

  const scheduleAutosave = useCallback(() => {
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      runSave();
    }, AUTOSAVE_DEBOUNCE_MS);
  }, [clearTimer, runSave]);

  // ── live preview ──────────────────────────────────────────────────
  // Separate from disk save: the iframe should refresh as the user
  // types so it feels live, but we don't want to slam fs writes on
  // every keystroke. 200ms is below human-noticeable typing latency
  // but well above the 16ms layout budget so the iframe doesn't churn.
  const [previewHtml, setPreviewHtml] = useState<string>(initialHtml);
  const previewTimerRef = useRef<number | null>(null);
  const schedulePreview = useCallback((html: string) => {
    if (previewTimerRef.current) {
      window.clearTimeout(previewTimerRef.current);
    }
    previewTimerRef.current = window.setTimeout(() => {
      previewTimerRef.current = null;
      setPreviewHtml(html);
    }, PREVIEW_DEBOUNCE_MS);
  }, []);

  // ── instrumented preview ──────────────────────────────────────────
  // Tag every opening tag with data-cos-src-line + inject the bridge
  // script. Memoized so the (mildly) expensive parse doesn't run on
  // unrelated re-renders (e.g. view-mode toggles).
  const instrumentedHtml = useMemo(
    () => instrumentHtmlForPreview(previewHtml),
    [previewHtml],
  );

  // ── scroll sync state ─────────────────────────────────────────────
  // `lastSyncedLineRef` tracks the last line we sent to or received
  // from the iframe. Used to break the obvious feedback loop: a click
  // in the preview moves the CM cursor, which would otherwise post a
  // sync message right back to the iframe and yank its scroll.
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const lastSyncedLineRef = useRef<number>(0);
  const cursorSyncTimerRef = useRef<number | null>(null);

  const postLineToPreview = useCallback((line: number) => {
    if (line === lastSyncedLineRef.current) return;
    lastSyncedLineRef.current = line;
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage({ type: "cos-html-scroll-to-line", line }, "*");
  }, []);

  const scheduleCursorSync = useCallback(
    (line: number) => {
      if (cursorSyncTimerRef.current) {
        window.clearTimeout(cursorSyncTimerRef.current);
      }
      cursorSyncTimerRef.current = window.setTimeout(() => {
        cursorSyncTimerRef.current = null;
        postLineToPreview(line);
      }, CURSOR_SYNC_DEBOUNCE_MS);
    },
    [postLineToPreview],
  );

  // ── CodeMirror mount ──────────────────────────────────────────────
  // CodeMirror's view is mutable and lives outside React's render
  // cycle. Mount once into the container ref; tear down on unmount.
  // Lazy-importing the CM modules so the chunk only loads when an
  // HTML doc is opened.
  const cmContainerRef = useRef<HTMLDivElement | null>(null);
  const cmViewRef = useRef<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    const container = cmContainerRef.current;
    if (!container) return;

    (async () => {
      const [
        { EditorState },
        { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection },
        { defaultKeymap, history, historyKeymap, indentWithTab },
        { html },
        { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching },
      ] = await Promise.all([
        import("@codemirror/state"),
        import("@codemirror/view"),
        import("@codemirror/commands"),
        import("@codemirror/lang-html"),
        import("@codemirror/language"),
      ]);

      if (cancelled || !container) return;

      const updateListener = EditorView.updateListener.of((v) => {
        if (v.docChanged) {
          const html = v.state.doc.toString();
          currentHtmlRef.current = html;
          dirtyRef.current = html !== baselineRef.current;
          publish();
          schedulePreview(html);
          if (dirtyRef.current) scheduleAutosave();
        }
        // Selection moved (cursor click, arrow keys, command-G, etc).
        // Translate to a 1-based line number and forward to the iframe
        // so the preview scrolls to follow. The sync is debounced and
        // deduped against `lastSyncedLineRef` so a rapid arrow-key
        // run doesn't cause a flickery scroll storm.
        if (v.selectionSet) {
          const head = v.state.selection.main.head;
          const line = v.state.doc.lineAt(head).number;
          scheduleCursorSync(line);
        }
      });

      const state = EditorState.create({
        doc: initialHtml,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          drawSelection(),
          history(),
          indentOnInput(),
          bracketMatching(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          html(),
          keymap.of([
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.lineWrapping,
          EditorState.tabSize.of(2),
          updateListener,
        ],
      });

      const view = new EditorView({ state, parent: container });
      cmViewRef.current = view;
    })().catch((err) => {
      // Loader failed — surface the error in the file area but don't
      // crash the surface. The save pipeline isn't wired yet, so no
      // dirty state to worry about.
      // eslint-disable-next-line no-console
      console.error("CodeMirror load failed", err);
    });

    return () => {
      cancelled = true;
      const v = cmViewRef.current as { destroy?: () => void } | null;
      if (v && typeof v.destroy === "function") v.destroy();
      cmViewRef.current = null;
    };
    // initialHtml is captured into the editor's initial state; we
    // don't want to re-mount when it changes (the parent re-keys on
    // relPath instead, which already remounts this component).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cmd+S → flush the debounce and save now.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        clearTimer();
        runSave();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clearTimer, runSave]);

  // Save when the window loses focus — closes the gap between the
  // 2s debounce and a Cmd+Tab away.
  useEffect(() => {
    function onBlur() {
      if (dirtyRef.current && saveStateRef.current.kind !== "saving") {
        clearTimer();
        runSave();
      }
    }
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [clearTimer, runSave]);

  // Flush on unmount (doc close / surface change).
  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      if (previewTimerRef.current) window.clearTimeout(previewTimerRef.current);
      if (cursorSyncTimerRef.current) {
        window.clearTimeout(cursorSyncTimerRef.current);
      }
      if (dirtyRef.current) {
        void invoke("content_write_file", {
          relPath: relPathRef.current,
          markdown: currentHtmlRef.current,
        });
      }
    };
  }, []);

  // Iframe → CodeMirror. The bridge script inside the iframe posts a
  // `cos-html-click` message with the deepest-element line whenever
  // the user clicks anywhere in the preview. Move the CM cursor to
  // that line and scroll it into view.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      // Filter to messages from our own iframe — postMessage on the
      // window catches everything (Tauri WebView, dev tools, etc.).
      if (e.source !== iframeRef.current?.contentWindow) return;
      const data = e.data as
        | { type?: string; line?: number }
        | null
        | undefined;
      if (
        !data ||
        data.type !== "cos-html-click" ||
        typeof data.line !== "number"
      ) {
        return;
      }
      const view = cmViewRef.current as
        | {
            state: {
              doc: {
                lines: number;
                line: (n: number) => { from: number };
              };
            };
            dispatch: (spec: unknown) => void;
            focus: () => void;
            domAtPos: (pos: number) => { node: Node };
          }
        | null;
      if (!view) return;
      // Suppress the immediate cursor→preview round trip the
      // dispatched selection would otherwise trigger.
      lastSyncedLineRef.current = data.line;
      const totalLines = view.state.doc.lines;
      const target = Math.min(Math.max(1, data.line), totalLines);
      const lineFrom = view.state.doc.line(target).from;
      view.dispatch({
        selection: { anchor: lineFrom },
        scrollIntoView: true,
      });
      view.focus();
      // Flash the destination .cm-line so it's visually obvious
      // where the cursor landed. rAF lets CM render the new line
      // before we walk the DOM. CM 6 virtualizes lines, so the
      // element we class up may be recycled if the user scrolls
      // away mid-flash — `replace` and the timeout below tolerate
      // that (worst case the class lingers on a wrong line for a
      // beat, then clears).
      window.requestAnimationFrame(() => {
        try {
          const dom = view.domAtPos(lineFrom);
          const start = (dom.node instanceof HTMLElement
            ? dom.node
            : dom.node.parentElement) as HTMLElement | null;
          const lineEl = start?.closest(".cm-line") as HTMLElement | null;
          if (!lineEl) return;
          lineEl.classList.add("cos-cm-flash");
          window.setTimeout(
            () => lineEl.classList.remove("cos-cm-flash"),
            1200,
          );
        } catch {
          // domAtPos can throw if the dispatch hasn't committed yet;
          // skip the flash rather than break the cursor move.
        }
      });
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // CodeMirror runs measurements based on its container's box. When
  // the source pane was previously display:none (preview-only mode)
  // and the user toggles back to split, CM needs a nudge to reflow —
  // otherwise the gutter, line wraps, and cursor caret can land off
  // by a row until the next keystroke triggers an internal measure.
  useEffect(() => {
    if (viewMode !== "split") return;
    const view = cmViewRef.current as
      | { requestMeasure?: () => void }
      | null;
    if (view?.requestMeasure) {
      // rAF: let the layout actually un-hide the source pane before
      // we ask CM to measure. requestMeasure() called the same tick
      // as display flips would still see clientHeight=0.
      const id = window.requestAnimationFrame(() => view.requestMeasure?.());
      return () => window.cancelAnimationFrame(id);
    }
  }, [viewMode]);

  return (
    <div className={`cos-html-shell mode-${viewMode}`}>
      <div className="cos-html-toolbar" role="toolbar" aria-label="Layout">
        <button
          type="button"
          className={`cos-html-mode-btn${viewMode === "split" ? " is-active" : ""}`}
          onClick={() => setViewMode("split")}
          title="Split — source + preview"
          aria-pressed={viewMode === "split"}
        >
          <Columns2 size={14} strokeWidth={1.75} aria-hidden />
          <span>Split</span>
        </button>
        <button
          type="button"
          className={`cos-html-mode-btn${viewMode === "preview" ? " is-active" : ""}`}
          onClick={() => setViewMode("preview")}
          title="Preview only"
          aria-pressed={viewMode === "preview"}
        >
          <Eye size={14} strokeWidth={1.75} aria-hidden />
          <span>Preview</span>
        </button>
      </div>
      <div
        className="cos-html-panes"
        ref={panesRef}
        style={
          {
            "--cos-html-source-width": `${sourcePct}%`,
          } as React.CSSProperties
        }
      >
        {/* Source pane stays mounted in both modes — display:none in
            preview mode keeps CodeMirror's view alive across toggles
            so the buffer doesn't have to re-mount + re-load. We call
            requestMeasure() on the toggle effect so layout reflows
            after a hidden→visible transition. */}
        <div className="cos-html-source" aria-label="HTML source">
          <div ref={cmContainerRef} className="cos-html-cm" />
        </div>
        <div
          className="cos-html-divider"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize source / preview split"
          aria-valuenow={Math.round(sourcePct)}
          aria-valuemin={SPLIT_MIN_PCT}
          aria-valuemax={SPLIT_MAX_PCT}
          tabIndex={0}
          onPointerDown={onDividerPointerDown}
          onKeyDown={onDividerKeyDown}
        />
        <div className="cos-html-preview" aria-label="Live preview">
          <iframe
            ref={iframeRef}
            // `allow-scripts` lets designed pages run their tab JS,
            // but omitting `allow-same-origin` keeps the iframe out
            // of localStorage / cookies on this origin. The content
            // is user-authored and lives under the local data root.
            sandbox="allow-scripts"
            srcDoc={instrumentedHtml}
            title={`Preview · ${relPath}`}
          />
        </div>
      </div>
    </div>
  );
}

function SaveStatusPill({ relPath }: { relPath: string }) {
  const [dirty, setDirty] = useState(false);
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);

  useEffect(() => {
    function on(e: Event) {
      const ce = e as CustomEvent<SavePayload>;
      if (ce.detail.relPath !== relPath) return;
      setDirty(ce.detail.dirty);
      setState(ce.detail.state);
      setLastSavedAt(ce.detail.lastSavedAt);
    }
    window.addEventListener(SAVE_EVENT, on);
    return () => window.removeEventListener(SAVE_EVENT, on);
  }, [relPath]);

  const pill = useMemo(
    () => statusPill(dirty, state, lastSavedAt),
    [dirty, state, lastSavedAt],
  );

  return (
    <span className={`cos-pill-chip ${pill.klass}`} title={pill.tooltip}>
      <span className={`cos-dot ${pill.dotKlass}`} aria-hidden />
      {pill.label}
    </span>
  );
}

function statusPill(
  dirty: boolean,
  save: SaveState,
  lastSavedAt: string | null,
): { label: string; tooltip: string; klass: string; dotKlass: string } {
  if (save.kind === "saving") {
    return {
      label: "saving…",
      tooltip: "Writing through audit log",
      klass: "is-warn",
      dotKlass: "cos-dot-warn",
    };
  }
  if (save.kind === "error") {
    return {
      label: "save failed",
      tooltip: save.error,
      klass: "is-bad",
      dotKlass: "cos-dot-bad",
    };
  }
  if (dirty) {
    return {
      label: "unsaved",
      tooltip: "Autosave in a couple of seconds · ⌘S saves now",
      klass: "is-warn",
      dotKlass: "cos-dot-warn",
    };
  }
  if (lastSavedAt) {
    return {
      label: "saved",
      tooltip: `Last saved ${lastSavedAt}`,
      klass: "is-ok",
      dotKlass: "cos-dot-ok",
    };
  }
  return {
    label: "ready",
    tooltip: "Loaded from disk",
    klass: "",
    dotKlass: "cos-dot-muted",
  };
}
