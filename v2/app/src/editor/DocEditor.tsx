import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import {
  Table,
  TableCell,
  TableHeader,
  TableRow,
} from "@tiptap/extension-table";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { common, createLowlight } from "lowlight";
import { Markdown } from "tiptap-markdown";

const lowlight = createLowlight(common);
import { X } from "lucide-react";

import "./editor.css";
import { openUrl } from "@tauri-apps/plugin-opener";

import { Annotations, type AnnotationItem } from "./annotations";
import {
  ANNOTATIONS_CHANGED_EVENT,
  AnnotationBubble,
  type AnnotationsChangedDetail,
} from "./AnnotationBubble";
import { AnnotationsPanel } from "./AnnotationsPanel";
import { EditorToolbar, findLinkRange } from "./EditorToolbar";
import { FindBar } from "./FindBar";
import { LinkDialog, type LinkDialogState } from "./LinkDialog";
import { OutlinePanel } from "./OutlinePanel";
import { ensureDocPath } from "./linkOpen";
import { resolveRelativePath } from "./resolveRelativePath";
import { time } from "../state/perf";
import { dismissRun, runSkill, useRun } from "../state/skillRuns";
import { showToast } from "../state/toasts";
import { sanitizeMarkdown } from "./sanitize-markdown";

const AUTOSAVE_DEBOUNCE_MS = 2000;

type DocFile = {
  rel_path: string;
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
 * field guards a cross-file save bug: when the user switches tabs
 * (A → B), the DocEditor instance does NOT unmount — only its
 * relPath prop changes. The `load` state lags one render behind
 * (it updates from a useEffect, after commit), so for one render
 * we'd otherwise render `<LoadedEditor key={B-0} relPath=B
 * initialMarkdown={A's content}>`. Tiptap's content normalization
 * can fire onUpdate during init, flip dirtyRef=true, and the next
 * render's unmount-cleanup flushes A's content to B's path. The
 * `for` tag lets the renderer ignore stale loads from a prior
 * relPath, so LoadedEditor only mounts with content that matches
 * its path. See cross-file save guards in DocEditor.test.tsx.
 */
type Load =
  | { kind: "loading"; for: string }
  | { kind: "ok"; for: string; doc: DocFile }
  | { kind: "error"; for: string; error: string };

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "error"; error: string };

type Props = {
  relPath: string;
  label: string;
  onClose: () => void;
  /** Optional substring to locate in the rendered doc and scroll into
   *  view on mount. Used by Home priority cards that fall back to the
   *  briefing — we land the user on the bullet they clicked. */
  scrollTo?: string;
};

export function DocEditor({ relPath, label, onClose, scrollTo }: Props) {
  const [load, setLoad] = useState<Load>(() => ({ kind: "loading", for: relPath }));
  // Render-time guard: if the relPath prop changed but our load state
  // is still pinned to the previous path, immediately reset to loading
  // so the renderer below sees a consistent (relPath, load.for) pair
  // and doesn't mount a LoadedEditor with mismatched content. This is
  // the React-blessed "derive state from props during render" idiom —
  // calling setLoad during render schedules a re-render but doesn't
  // recursively re-enter this one. The guard exists because Tiptap's
  // content normalization can fire onUpdate during the brief window
  // when a stale-load LoadedEditor is mounted, flipping dirtyRef=true
  // and causing the unmount-cleanup to write A's content to B's path.
  if (load.for !== relPath) {
    setLoad({ kind: "loading", for: relPath });
  }
  const docRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);

  // Measure the (sticky) doc-header so the (sticky) editor toolbar can
  // pin just below it. Without this the toolbar would either overlap
  // the header or sit too far down. ResizeObserver covers the case
  // where the header re-flows because of pending-annotations / digest
  // / publish buttons coming in/out.
  useEffect(() => {
    const doc = docRef.current;
    const header = headerRef.current;
    if (!doc || !header) return;
    const sync = () => {
      doc.style.setProperty(
        "--cos-doc-header-height",
        `${header.offsetHeight}px`,
      );
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(header);
    return () => ro.disconnect();
  }, []);
  // Bumping `reloadNonce` re-fires the load effect AND keys the
  // LoadedEditor below — that forces a clean Tiptap mount with the
  // freshly-read markdown so a /digest-meeting run shows up in the
  // editor without a stale-baseline mismatch.
  const [reloadNonce, setReloadNonce] = useState(0);
  const [pendingAnnotations, setPendingAnnotations] = useState(0);
  const digestId = `digest-meeting:${relPath}`;
  const digestRun = useRun(digestId);
  const digesting = digestRun?.state === "running";
  const digestError =
    digestRun?.state === "error" ? digestRun.error ?? null : null;
  const processId = `process-annotations:${relPath}`;
  const processRun = useRun(processId);
  const processing = processRun?.state === "running";
  const processError =
    processRun?.state === "error" ? processRun.error ?? null : null;
  const publishId = `publish-to-gdoc:${relPath}`;
  const publishRun = useRun(publishId);
  const publishing = publishRun?.state === "running";
  const publishError =
    publishRun?.state === "error" ? publishRun.error ?? null : null;

  const publish = () => {
    if (publishing) return;
    runSkill(publishId, `Publish to GDoc — ${label}`, async () => {
      const result = await invoke<{ url: string; summary: string }>(
        "publish_to_gdoc",
        { relPath },
      );
      // Open the resulting URL in the user's default browser.
      try {
        await openUrl(result.url);
      } catch {
        // If the open fails (no opener plugin permission, no browser),
        // the run state still has the URL via summary; user can copy.
      }
      return result;
    }).catch(() => {
      /* error captured in run state */
    });
  };

  // Re-count un-processed annotations whenever the doc reloads OR
  // the bubble fires its change event after a save. The button needs
  // to flip on as soon as the first note is left, not just after a
  // file reload.
  useEffect(() => {
    invoke<AnnotationItem[]>("annotations_list", { relPath })
      .then((items) => {
        setPendingAnnotations(items.filter((a) => !a.processedAt).length);
      })
      .catch(() => setPendingAnnotations(0));
  }, [relPath, reloadNonce]);

  useEffect(() => {
    function onChanged(e: Event) {
      const detail = (e as CustomEvent<AnnotationsChangedDetail>).detail;
      if (!detail || detail.relPath !== relPath) return;
      setPendingAnnotations(
        detail.items.filter((a) => !a.processedAt).length,
      );
    }
    window.addEventListener(ANNOTATIONS_CHANGED_EVENT, onChanged);
    return () =>
      window.removeEventListener(ANNOTATIONS_CHANGED_EVENT, onChanged);
  }, [relPath]);

  // After /process-ui-annotations completes, reload the doc + re-count.
  const lastProcessGen = useRef(processRun?.generation ?? 0);
  useEffect(() => {
    const gen = processRun?.generation ?? 0;
    if (gen > lastProcessGen.current && processRun?.state === "done") {
      lastProcessGen.current = gen;
      setReloadNonce((n) => n + 1);
    }
  }, [processRun]);

  const processAnnotations = () => {
    if (processing) return;
    runSkill(
      processId,
      `Process annotations — ${label}`,
      async () =>
        await invoke<{ rel_path: string; summary: string }>(
          "annotations_process",
          { relPath },
        ),
    ).catch(() => {
      /* error captured in run state */
    });
  };

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
  }, [relPath, reloadNonce]);

  // Reload from disk whenever a digest run for this path completes
  // — handles the case where the user navigated away during the run
  // and the file changed under us.
  const lastDigestGen = useRef(digestRun?.generation ?? 0);
  useEffect(() => {
    const gen = digestRun?.generation ?? 0;
    if (gen > lastDigestGen.current && digestRun?.state === "done") {
      lastDigestGen.current = gen;
      setReloadNonce((n) => n + 1);
    }
  }, [digestRun]);

  const isSession = isSessionPath(relPath);

  const digest = () => {
    if (digesting) return;
    runSkill(digestId, `Digest — ${label}`, async () => {
      return await invoke<{ rel_path: string; summary: string }>(
        "session_digest",
        { relPath },
      );
    }).catch(() => {
      /* error captured in run state */
    });
  };

  return (
    <div className="cos-doc" ref={docRef}>
      <header className="cos-doc-header" ref={headerRef}>
        <div className="cos-doc-crumb">
          <span className="cos-doc-label">{label}</span>
          <code className="cos-doc-path">{relPath}</code>
        </div>
        <div className="cos-doc-actions">
          {load.kind === "ok" && <WordCount relPath={relPath} />}
          {load.kind === "ok" && <LoadedStatus relPath={relPath} />}
          {isSession && load.kind === "ok" && (
            <button
              type="button"
              className="cos-btn cos-btn-ghost cos-doc-digest"
              onClick={digest}
              disabled={digesting}
              title="Digest raw notes into structured session notes via /digest-meeting"
            >
              {digesting ? (
                <>
                  <span className="cos-newtask-spinner" aria-hidden />
                  digesting…
                </>
              ) : (
                "Digest"
              )}
            </button>
          )}
          {pendingAnnotations > 0 && load.kind === "ok" && (
            <button
              type="button"
              className="cos-btn cos-doc-digest"
              onClick={processAnnotations}
              disabled={processing}
              title="Apply each annotation's instruction via /process-ui-annotations"
            >
              {processing ? (
                <>
                  <span className="cos-newtask-spinner" aria-hidden />
                  processing…
                </>
              ) : (
                <>
                  Process {pendingAnnotations} annotation
                  {pendingAnnotations === 1 ? "" : "s"}
                </>
              )}
            </button>
          )}
          {load.kind === "ok" && (
            <button
              type="button"
              className="cos-btn cos-btn-ghost cos-doc-digest"
              onClick={publish}
              disabled={publishing}
              title="Publish this doc to a Google Doc via /publish-to-gdoc"
            >
              {publishing ? (
                <>
                  <span className="cos-newtask-spinner" aria-hidden />
                  publishing…
                </>
              ) : (
                "Publish to GDocs"
              )}
            </button>
          )}
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

      {digesting && (
        <div className="cos-newtask-status" role="status" aria-live="polite">
          Claude is digesting raw notes — this may take a minute…
        </div>
      )}
      {digestError && (
        <div className="cos-newtask-error">
          Digest failed: {digestError}
          <button
            type="button"
            className="cos-btn cos-btn-ghost"
            onClick={() => dismissRun(digestId)}
            style={{ marginLeft: 8 }}
          >
            dismiss
          </button>
        </div>
      )}
      {processing && (
        <div className="cos-newtask-status" role="status" aria-live="polite">
          Claude is applying {pendingAnnotations} annotation
          {pendingAnnotations === 1 ? "" : "s"} to this doc — safe to
          navigate away.
        </div>
      )}
      {processError && (
        <div className="cos-newtask-error">
          Process failed: {processError}
          <button
            type="button"
            className="cos-btn cos-btn-ghost"
            onClick={() => dismissRun(processId)}
            style={{ marginLeft: 8 }}
          >
            dismiss
          </button>
        </div>
      )}
      {publishing && (
        <div className="cos-newtask-status" role="status" aria-live="polite">
          Publishing to Google Docs — this opens the resulting URL in
          your browser when ready.
        </div>
      )}
      {publishError && (
        <div className="cos-newtask-error">
          Publish failed: {publishError}
          <button
            type="button"
            className="cos-btn cos-btn-ghost"
            onClick={() => dismissRun(publishId)}
            style={{ marginLeft: 8 }}
          >
            dismiss
          </button>
        </div>
      )}

      {(load.kind === "loading" || load.for !== relPath) && (
        <div className="cos-empty">Loading document…</div>
      )}
      {load.kind === "error" && load.for === relPath && (
        <div className="cos-empty cos-empty-error">
          Could not read: {load.error}
        </div>
      )}
      {load.kind === "ok" && load.for === relPath && (
        <LoadedEditor
          key={`${relPath}-${reloadNonce}`}
          relPath={relPath}
          initialMarkdown={load.doc.markdown}
          scrollTo={scrollTo}
        />
      )}
    </div>
  );
}

/**
 * Session files live under areas/one-on-ones/<rel>/<slug>/sessions/ or
 * areas/meetings/<slug>/sessions/. Anything else (READMEs, free-form
 * areas/* docs) doesn't have a Digest workflow.
 */
function isSessionPath(relPath: string): boolean {
  return (
    /^areas\/one-on-ones\/.+\/sessions\/[^/]+\.md$/.test(relPath) ||
    /^areas\/meetings\/.+\/sessions\/[^/]+\.md$/.test(relPath)
  );
}

// Status pill lives in the header; its state is communicated via custom events
// so we don't have to hoist every editor detail into the wrapper.
const SAVE_EVENT = "cos:save-state";
const STATS_EVENT = "cos:editor-stats";
type SavePayload = {
  relPath: string;
  dirty: boolean;
  state: SaveState;
  lastSavedAt: string | null;
};
type StatsPayload = {
  relPath: string;
  words: number;
  readMinutes: number;
  /** Total characters (visible text only — fenced code, link hrefs
   *  excluded by textBetween). */
  chars: number;
  /** Number of paragraphs (excluding empties). */
  paragraphs: number;
  /** Heading count across all levels. */
  headings: number;
};

function publishSaveState(payload: SavePayload) {
  window.dispatchEvent(
    new CustomEvent<SavePayload>(SAVE_EVENT, { detail: payload }),
  );
}

function publishStats(payload: StatsPayload) {
  window.dispatchEvent(
    new CustomEvent<StatsPayload>(STATS_EVENT, { detail: payload }),
  );
}

/** Walk up the DOM looking for the nearest ancestor that actually
 *  scrolls (overflow-y: auto/scroll AND scrollHeight > clientHeight).
 *  Used by the editor's scroll-restore path so the saved scrollTop
 *  applies to the right node — the cos-doc wrapper doesn't scroll
 *  itself; the surface body usually does. Returns null when nothing
 *  scrolls (caller falls back to documentElement). */
function findScrollingAncestor(start: HTMLElement): HTMLElement | null {
  let el: HTMLElement | null = start;
  while (el) {
    const style = window.getComputedStyle(el);
    const overflowY = style.overflowY;
    const canScrollVertically =
      overflowY === "auto" || overflowY === "scroll";
    if (canScrollVertically && el.scrollHeight > el.clientHeight) {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

/** Walk the doc once and emit the count tuple {words, chars,
 *  paragraphs, headings}. Centralizing the walk so onUpdate doesn't
 *  fork between two text-extraction paths. */
function collectDocStats(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  editor: any,
): { text: string; paragraphs: number; headings: number } {
  let paragraphs = 0;
  let headings = 0;
  editor.state.doc.descendants((node: { type: { name: string }; textContent: string }) => {
    if (node.type.name === "paragraph") {
      if (node.textContent.trim().length > 0) paragraphs++;
    } else if (node.type.name === "heading") {
      headings++;
    }
  });
  const text = editor.state.doc.textBetween(
    0,
    editor.state.doc.content.size,
    " ",
    " ",
  );
  return { text, paragraphs, headings };
}

/** Count words in a string (Unicode-aware whitespace split). 200 wpm
 *  is the conventional "average reader" rate; rounded up so a 50-word
 *  doc still shows "1m" not "0m". */
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

export function readMinutesFor(words: number): number {
  if (words === 0) return 0;
  return Math.max(1, Math.round(words / 200));
}

/** Word count + read-time chip in the doc header. Only renders for
 *  docs over 100 words so trivial files (READMEs with three bullets)
 *  don't get a vanity badge. Subscribes to STATS_EVENT so the count
 *  stays live as the user types. Click → stats popover with the full
 *  count tuple (words / chars / paragraphs / headings). */
function WordCount({ relPath }: { relPath: string }) {
  const [stats, setStats] = useState<StatsPayload | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function on(e: Event) {
      const ce = e as CustomEvent<StatsPayload>;
      if (ce.detail.relPath !== relPath) return;
      setStats(ce.detail);
    }
    window.addEventListener(STATS_EVENT, on);
    return () => window.removeEventListener(STATS_EVENT, on);
  }, [relPath]);

  // Close popover on outside click + Esc.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!stats || stats.words < 100) return null;
  return (
    <div className="cos-doc-wordcount-wrap" ref={ref}>
      <button
        type="button"
        className="cos-doc-wordcount"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        {stats.words.toLocaleString()} words · {stats.readMinutes}m read
      </button>
      {open && (
        <div className="cos-doc-wordcount-popover" role="dialog">
          <dl className="cos-doc-wordcount-grid">
            <dt>Words</dt>
            <dd>{stats.words.toLocaleString()}</dd>
            <dt>Characters</dt>
            <dd>{stats.chars.toLocaleString()}</dd>
            <dt>Paragraphs</dt>
            <dd>{stats.paragraphs.toLocaleString()}</dd>
            <dt>Headings</dt>
            <dd>{stats.headings.toLocaleString()}</dd>
            <dt>Read time</dt>
            <dd>~{stats.readMinutes} min @ 200 wpm</dd>
          </dl>
        </div>
      )}
    </div>
  );
}

function LoadedStatus({ relPath }: { relPath: string }) {
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

function LoadedEditor({
  relPath,
  initialMarkdown,
  scrollTo,
}: {
  relPath: string;
  initialMarkdown: string;
  scrollTo?: string;
}) {
  const baselineRef = useRef(initialMarkdown);
  const currentMarkdownRef = useRef(initialMarkdown);
  const dirtyRef = useRef(false);
  const saveStateRef = useRef<SaveState>({ kind: "idle" });
  const lastSavedAtRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);
  // Pinned to the relPath this instance was mounted with. The parent
  // keys LoadedEditor by relPath, so an instance only ever serves one
  // path — and the unmount cleanup at the bottom writes via this ref.
  // Reassigning on every render (the previous `relPathRef.current =
  // relPath` pattern) caused a cross-file save bug: under React 18
  // concurrent reconciliation, a speculative render of the *outgoing*
  // instance with the *incoming* relPath would mutate the ref before
  // unmount, so dirty-flush wrote the old editor's content to the new
  // tab's path. Symptom in the wild: Bob-session content overwrote
  // Aaron-README, Aaron-session content overwrote Grace-skip-level.
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
    const markdown = currentMarkdownRef.current;
    saveStateRef.current = { kind: "saving" };
    publish();
    try {
      // Wrap the save IPC so PRD-101's editor-input ≤50ms p99 budget
      // is measurable. The mark closes when the IPC resolves so this
      // captures the round-trip including audit + snapshot writes.
      await time("editor-input", () =>
        invoke<SaveResult>("content_write_file", {
          relPath: relPathRef.current,
          markdown,
        }),
      );
      baselineRef.current = markdown;
      dirtyRef.current = false;
      lastSavedAtRef.current = new Date().toISOString();
      saveStateRef.current = { kind: "idle" };
      publish();
    } catch (error) {
      const message = String(error);
      saveStateRef.current = { kind: "error", error: message };
      publish();
      // Status pill shows "save failed" but it's small, header-tier,
      // and easy to miss when a long-running skill panel is open.
      // Toast is a hard-to-miss "your edits didn't persist" signal
      // with the underlying error inline so the user can act on it
      // (or paste it into a bug report). The retry button kicks the
      // save loop again — common cause is a transient IPC blip.
      const filename =
        relPathRef.current.split("/").pop() ?? relPathRef.current;
      showToast({
        kind: "error",
        text: `Couldn't save ${filename}: ${message}`,
        action: {
          label: "Retry",
          onClick: () => {
            // Clear the error state so the next attempt isn't gated.
            saveStateRef.current = { kind: "idle" };
            publish();
            runSave();
          },
        },
        durationMs: 0, // sticky — failed saves shouldn't fade away
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

  const editor = useEditor({
    extensions: [
      // StarterKit's plain code block is replaced by CodeBlockLowlight so
      // fenced ```ts blocks get syntax-highlighted instead of rendered as
      // bare monospace text. Same swap v1 used.
      StarterKit.configure({ codeBlock: false }),
      Link.configure({ openOnClick: false, autolink: true }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: false, allowTableNodeSelection: true }),
      TableRow,
      TableHeader,
      TableCell,
      CodeBlockLowlight.configure({ lowlight }),
      // tightLists + bulletListMarker keep our serialized markdown matching
      // the rest of the corpus (compact lists, `-` bullets). transformCopied
      // makes copy-out land as markdown elsewhere, not HTML.
      Markdown.configure({
        html: true,
        tightLists: true,
        bulletListMarker: "-",
        transformPastedText: true,
        transformCopiedText: true,
      }),
      Annotations.configure({ initial: [] }),
    ],
    content: initialMarkdown,
    autofocus: true,
    onUpdate: ({ editor }) => {
      const raw = editor.storage.markdown?.getMarkdown();
      const current: string =
        raw !== undefined ? sanitizeMarkdown(raw) : baselineRef.current;
      currentMarkdownRef.current = current;
      dirtyRef.current = current !== baselineRef.current;
      publish();
      // Word count + read time. textBetween over the doc is cheaper
      // than the markdown round-trip and tracks the rendered prose
      // (no fenced code, no link hrefs).
      const { text, paragraphs, headings } = collectDocStats(editor);
      const words = countWords(text);
      publishStats({
        relPath: relPathRef.current,
        words,
        readMinutes: readMinutesFor(words),
        chars: text.length,
        paragraphs,
        headings,
      });
      if (dirtyRef.current) scheduleAutosave();
    },
  });

  // Load annotations on mount + whenever the path changes; push them
  // into the editor's annotation plugin via setAnnotations.
  useEffect(() => {
    if (!editor) return;
    let cancelled = false;
    invoke<AnnotationItem[]>("annotations_list", { relPath })
      .then((items) => {
        if (!cancelled) editor.commands.setAnnotations(items);
      })
      .catch(() => {
        if (!cancelled) editor.commands.setAnnotations([]);
      });
    return () => {
      cancelled = true;
    };
  }, [editor, relPath]);

  // Fire word-count stats once on initial mount so freshly-opened docs
  // get a count even before the user types. onUpdate carries it after.
  useEffect(() => {
    if (!editor) return;
    const { text, paragraphs, headings } = collectDocStats(editor);
    const words = countWords(text);
    publishStats({
      relPath,
      words,
      readMinutes: readMinutesFor(words),
      chars: text.length,
      paragraphs,
      headings,
    });
  }, [editor, relPath]);

  // Cmd+S → flush any pending debounce and save now.
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
  // 2-second debounce and a Cmd+Tab away. Same belt-and-suspenders
  // hedge v1 had.
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

  // Link-dialog state — replaces the old window.prompt flow. The
  // toolbar's link button + a plain click on an existing link both
  // route through this. The selection snapshot is captured at open
  // time because focusing the dialog input collapses ProseMirror's
  // selection.
  const [linkDialog, setLinkDialog] = useState<LinkDialogState>({
    open: false,
  });
  const linkSnapshotRef = useRef<{
    from: number;
    to: number;
    onLink: boolean;
    hasSelection: boolean;
  } | null>(null);

  const openLinkDialog = useCallback(
    (snapshot: {
      from: number;
      to: number;
      initialHref: string;
      initialText: string;
      hasSelection: boolean;
      onLink: boolean;
    }) => {
      linkSnapshotRef.current = {
        from: snapshot.from,
        to: snapshot.to,
        onLink: snapshot.onLink,
        hasSelection: snapshot.hasSelection,
      };
      setLinkDialog({
        open: true,
        mode: snapshot.onLink ? "edit" : "create",
        initialHref: snapshot.initialHref,
        initialText: snapshot.initialText,
        // Need a separate text field only when there's no existing
        // selection / link span to anchor the link to. With either,
        // the inline text is whatever was already there.
        allowEditText: !snapshot.hasSelection && !snapshot.onLink,
      });
    },
    [],
  );

  const closeLinkDialog = useCallback(() => {
    setLinkDialog({ open: false });
    linkSnapshotRef.current = null;
    editor?.commands.focus();
  }, [editor]);

  const commitLinkDialog = useCallback(
    (result: { href: string; text: string | null }) => {
      if (!editor) return;
      const snap = linkSnapshotRef.current;
      const chain = editor.chain().focus();
      if (snap) {
        chain.setTextSelection({ from: snap.from, to: snap.to });
      }
      if (result.text !== null) {
        // Insertion mode: no selection / link, write the display text
        // and link it in one transaction.
        chain
          .insertContent({
            type: "text",
            text: result.text,
            marks: [{ type: "link", attrs: { href: result.href } }],
          })
          .run();
      } else {
        chain.setLink({ href: result.href }).run();
      }
      closeLinkDialog();
    },
    [editor, closeLinkDialog],
  );

  const removeLinkDialog = useCallback(() => {
    if (!editor) return;
    const snap = linkSnapshotRef.current;
    const chain = editor.chain().focus();
    if (snap) {
      chain.setTextSelection({ from: snap.from, to: snap.to });
    }
    chain.unsetLink().run();
    closeLinkDialog();
  }, [editor, closeLinkDialog]);

  // In-editor link clicks. Three flows depending on intent:
  //   1. cmd/ctrl + click (or middle-click) on http(s) → open in
  //      external browser via the Tauri opener plugin.
  //   2. cmd/ctrl + click on anything else → treat as a content-tree
  //      relative path, resolve, dispatch cos:open-doc so Shell
  //      navigates within the app.
  //   3. plain click on a link → open the LinkDialog so the user can
  //      see + change the URL or remove the link.
  // We always preventDefault on anchor clicks because the underlying
  // <a> element would otherwise trigger the webview's default
  // navigation, which is what was leaking to "tries to open a browser"
  // for relative paths.
  // Click handler mounts on a wrapper div instead of editor.view.dom —
  // the latter logs "[tiptap error]: editor view not available" if
  // accessed before mount in React 19 strict mode (and that thrown
  // error blanked the surface, since there was no error boundary).
  // Same wrapper hosts the scroll-into-view logic below.
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  // B7-CP28: paste an image (clipboard) → write to data/files/attachments/...
  // and insert ![alt](rel-path) at the cursor. Clipboard image is the
  // common case (screenshots); drop is similar but not wired yet.
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!editor || !container) return;
    async function onPaste(e: ClipboardEvent) {
      const items = e.clipboardData?.items;
      if (!items || items.length === 0) return;
      const imageItem = Array.from(items).find((it) =>
        it.type.startsWith("image/"),
      );
      if (!imageItem) return;
      const file = imageItem.getAsFile();
      if (!file) return;
      e.preventDefault();
      try {
        const buf = await file.arrayBuffer();
        const bytes = Array.from(new Uint8Array(buf));
        // Build a plausible filename — clipboard images usually have
        // generic ones like "image.png" or none at all.
        const ext = (file.type.split("/")[1] || "png").replace(
          /[^a-z0-9]/gi,
          "",
        );
        const stamp = new Date()
          .toISOString()
          .replace(/[:.]/g, "-")
          .replace(/T/, "-");
        const filename =
          file.name && file.name.length > 0 && /\.[a-z0-9]+$/i.test(file.name)
            ? file.name
            : `paste-${stamp}.${ext}`;
        const rel = await invoke<string>("content_write_attachment", {
          docRelPath: relPathRef.current,
          filename,
          bytes,
        });
        editor
          ?.chain()
          .focus()
          .insertContent(`![${file.name || "image"}](/${rel})`)
          .run();
      } catch (error) {
        showToast({
          kind: "error",
          text: `Couldn't paste image: ${String(error)}`,
        });
      }
    }
    container.addEventListener("paste", onPaste);
    return () => container.removeEventListener("paste", onPaste);
  }, [editor]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!editor || !container) return;
    const dom = container;
    function onClick(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest("a") as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href) return;
      // Always swallow the default — even for plain clicks, where we
      // want to open the link dialog, not let the webview navigate.
      e.preventDefault();
      const wantsOpen = e.metaKey || e.ctrlKey || e.button === 1;
      const isExternal = /^https?:\/\//i.test(href);
      if (wantsOpen && isExternal) {
        openUrl(href).catch(() => {
          // Opener-plugin disabled or failed — copy as a fallback so
          // the user can still reach the link.
          navigator.clipboard?.writeText(href).catch(() => {});
        });
        return;
      }
      if (wantsOpen) {
        // Anything non-external + cmd-click is treated as content-
        // tree relative. Drop a leading "/" so absolute-style paths
        // ("/projects/x/README.md") work the same as bare ones.
        const normalized = href.replace(/^\//, "");
        const resolved = /^\.{1,2}\//.test(normalized)
          ? resolveRelativePath(relPathRef.current, normalized)
          : normalized;
        if (!resolved) return;
        const final = ensureDocPath(resolved);
        const label =
          final.split("/").pop()?.replace(/\.md$/, "") ?? final;
        window.dispatchEvent(
          new CustomEvent("cos:open-doc", {
            detail: { relPath: final, label },
          }),
        );
        return;
      }
      // Plain click → open the link dialog for editing.
      const linkRange = findLinkRange(editor, editor.view.posAtDOM(anchor, 0));
      const text = anchor.textContent ?? "";
      openLinkDialog({
        from: linkRange?.from ?? 0,
        to: linkRange?.to ?? 0,
        initialHref: href,
        initialText: text,
        hasSelection: !!linkRange,
        onLink: true,
      });
    }
    dom.addEventListener("click", onClick);
    return () => dom.removeEventListener("click", onClick);
  }, [editor, openLinkDialog]);

  // Flush on unmount (doc close / surface change). Fire-and-forget is the
  // best a webview can do on teardown; the 2s debounce keeps the window of
  // potentially-lost edits small.
  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      if (dirtyRef.current) {
        void invoke("content_write_file", {
          relPath: relPathRef.current,
          markdown: currentMarkdownRef.current,
        });
      }
    };
  }, []);

  // Persist scrollTop per relPath so reopening a doc lands the user
  // back where they were. Per-session (sessionStorage) — survives
  // surface switches but not a fresh launch, which is what feels
  // right: a quiet "I picked up where you left off" within a work
  // session, with the convention that a fresh launch starts you at
  // the top so cold-start always shows the doc lede.
  const SCROLL_KEY = `cos.editor-scroll.${relPath}`;
  useEffect(() => {
    const root = scrollContainerRef.current;
    if (!editor || !root || scrollTo) return;
    // Restore on mount once the editor has rendered. rAF gives Tiptap
    // a tick to commit content.
    const id = window.requestAnimationFrame(() => {
      const saved = window.sessionStorage.getItem(SCROLL_KEY);
      if (!saved) return;
      const top = Number(saved);
      if (Number.isFinite(top) && top > 0) {
        // The container itself scrolls along with the page; walk up
        // until we find the scrolling ancestor. The cos-doc wrapper
        // doesn't itself scroll on most surfaces; the surface body
        // does. Use document.scrollingElement as the fallback.
        const scroller =
          findScrollingAncestor(root) ||
          document.scrollingElement ||
          document.documentElement;
        scroller.scrollTop = top;
      }
    });
    return () => window.cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, relPath]);

  // Save scrollTop on the closest scrolling ancestor as the user
  // scrolls. Throttle via rAF so we're not slamming sessionStorage on
  // every scroll event.
  useEffect(() => {
    const root = scrollContainerRef.current;
    if (!root) return;
    const scroller =
      findScrollingAncestor(root) ||
      document.scrollingElement ||
      document.documentElement;
    let pending = 0;
    function onScroll() {
      if (pending) return;
      pending = window.requestAnimationFrame(() => {
        pending = 0;
        const top = (scroller as HTMLElement).scrollTop;
        try {
          window.sessionStorage.setItem(SCROLL_KEY, String(top));
        } catch {
          // ignore quota errors
        }
      });
    }
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (pending) window.cancelAnimationFrame(pending);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relPath]);

  // After the editor renders the doc, scroll to the first occurrence
  // of `scrollTo` (case-insensitive). Used by Home priority cards that
  // fall back to the briefing — we want to land the user on the right
  // bullet, not at the top of the doc. Reuses scrollContainerRef
  // declared above with the click handler.
  useEffect(() => {
    if (!editor || !scrollTo) return;
    const needle = scrollTo.trim().toLowerCase();
    if (!needle) return;
    // requestAnimationFrame: wait for Tiptap to commit content + the
    // browser to lay it out, otherwise the bounding rect is stale.
    const id = window.requestAnimationFrame(() => {
      const root = scrollContainerRef.current;
      if (!root) return;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node: Node | null = walker.nextNode();
      while (node) {
        const value = node.nodeValue ?? "";
        if (value.toLowerCase().includes(needle)) {
          const el = node.parentElement;
          if (el) {
            el.scrollIntoView({ block: "center", behavior: "smooth" });
            // Brief flash so the eye can find the target.
            el.classList.add("cos-scroll-flash");
            window.setTimeout(
              () => el.classList.remove("cos-scroll-flash"),
              1600,
            );
          }
          return;
        }
        node = walker.nextNode();
      }
    });
    return () => window.cancelAnimationFrame(id);
  }, [editor, scrollTo]);

  // Focus mode (CP4) — hides toolbar / outline / annotations panel
  // for distraction-free writing. Cmd+. toggles. Persisted per-doc
  // via sessionStorage so you can keep a particular doc in focus
  // mode while another stays in full-chrome mode.
  const FOCUS_KEY = `cos.focus-mode.${relPath}`;
  const [focusMode, setFocusMode] = useState<boolean>(() => {
    try {
      return window.sessionStorage.getItem(FOCUS_KEY) === "true";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      // Cmd+. — period — toggles focus mode. Tested on US layout;
      // on other layouts where "." needs Shift this still resolves
      // to the period char so the chord is consistent.
      if (e.key === "." || e.key === ">") {
        e.preventDefault();
        setFocusMode((v) => {
          const next = !v;
          try {
            window.sessionStorage.setItem(FOCUS_KEY, String(next));
          } catch {
            // ignore
          }
          return next;
        });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [FOCUS_KEY]);

  // Cmd+F opens the floating find bar. Mounted on the wrapper div so
  // the listener doesn't steal Cmd+F when other surfaces are showing.
  const [findOpen, setFindOpen] = useState(false);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isFind =
        (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey &&
        e.key.toLowerCase() === "f";
      if (!isFind) return;
      // Only intercept when this editor is mounted AND focused (or the
      // user is somewhere inside the doc-shell). The container ref check
      // below handles the latter; this guard handles the former.
      if (!scrollContainerRef.current) return;
      const target = e.target as HTMLElement | null;
      const inside =
        target instanceof Node &&
        scrollContainerRef.current.contains(target);
      const isEditorFocused = editor?.isFocused ?? false;
      if (!inside && !isEditorFocused) return;
      e.preventDefault();
      e.stopPropagation();
      setFindOpen(true);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editor]);

  if (!editor) return <div className="cos-empty">Initializing editor…</div>;

  return (
    <div className={`cos-editor-shell${focusMode ? " is-focus-mode" : ""}`}>
      {!focusMode && (
        <EditorToolbar editor={editor} onEditLink={openLinkDialog} />
      )}
      <FindBar
        editor={editor}
        open={findOpen}
        onClose={() => setFindOpen(false)}
      />
      {!focusMode && <OutlinePanel editor={editor} />}
      {!focusMode && <AnnotationsPanel editor={editor} relPath={relPath} />}
      {focusMode && (
        <button
          type="button"
          className="cos-focus-exit"
          onClick={() => {
            setFocusMode(false);
            try {
              window.sessionStorage.setItem(FOCUS_KEY, "false");
            } catch {
              // ignore
            }
          }}
          title="Exit focus mode (⌘.)"
        >
          ✕ exit focus
        </button>
      )}
      <div ref={scrollContainerRef}>
        <EditorContent editor={editor} className="cos-tiptap" />
      </div>
      <AnnotationBubble editor={editor} relPath={relPath} />
      <LinkDialog
        state={linkDialog}
        onCommit={commitLinkDialog}
        onRemove={removeLinkDialog}
        onCancel={closeLinkDialog}
      />
    </div>
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
