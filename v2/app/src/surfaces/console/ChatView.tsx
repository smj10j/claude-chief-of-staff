/**
 * PRD-116 Phase 2.5 — chat-mode renderer for the Console surface.
 *
 * Wires the chatSession reducer to a Tauri event subscription and
 * renders the conversation feed + input box. Sibling to the raw PTY
 * mode in `Console.tsx`; the parent picks which one to mount.
 *
 * What's here today (Phase 2.5):
 *   - Stream-json transport via `chat_open` / `chat_send` IPCs
 *   - Markdown rendering of assistant messages (Tiptap MarkdownView)
 *   - Tool-call cards with diff rendering
 *   - Header chips (model, mode, cwd, cost, context %)
 *   - Slash-command popover (sources from .claude/commands/)
 *   - Image paste + file drop on the input
 *   - Queued-input UI
 *   - Auto-scroll-pause + jump-to-latest pill
 *   - In-conversation Cmd+F find bar
 *   - Up-arrow recalls user-turn history
 *   - Edit-prior-turn + regenerate hover actions
 *
 * Explicitly deferred:
 *   - Inline approval cards (needs --permission-prompt-tool MCP)
 *   - Plan-mode UI (richer approval card variant)
 *   - Mode-toggle bridging via --resume (raw ↔ chat preserves session)
 */
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  ArrowDown,
  ArrowUpRight,
  Image as ImageIcon,
  Search,
  Send,
  Square,
  X,
} from "lucide-react";

import {
  addUserTurn,
  applyEvent,
  applyExit,
  applyStderr,
  autoLabelTabFromFirstTurn,
  bumpUnseenCompletion,
  dequeueTurn,
  enqueueTurn,
  getActiveTabId,
  getTab,
  getVersion,
  setTabSession,
  subscribeChat,
  updateTab,
  type ChatItem,
  type ChatSession,
  type ChatSessionMeta,
  type PendingAttachment,
  type TabId,
} from "../../state/chatSession";
import {
  CONSOLE_RUN_HERE_EVENT,
  type ConsoleRunHerePayload,
} from "../../state/consoleRunHere";
import { recordRecent } from "../../state/recentDocs";
import { ChatMarkdown } from "./ChatMarkdown";
import { ToolCallCard } from "./ToolCallCard";

type OpenResult = {
  handle: string;
  binary_path: string;
  cwd: string;
  argv: string[];
  transcript_md_rel?: string | null;
};

type LocalState =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "error"; message: string };

type SlashCommand = {
  name: string;
  source: "workspace" | "user" | "plugin" | "builtin";
  description: string | null;
};

export function ChatView({
  tabId,
  permissionMode,
  model,
}: {
  /** Stable tab identifier. The component is keyed on this in the
   *  parent so a switch creates a fresh ChatView with its own local
   *  UI state; per-tab data that should persist across switches
   *  (draft text, pending attachments) lives on the tab record in
   *  the chatSession store, not in this component's state. */
  tabId: TabId;
  /** Default permission mode for the spawned session. Phase 2.5 ships
   *  without inline approval cards. `auto` (Claude's auto-decide
   *  mode) is the practical default — `default`/`plan` block on
   *  tool calls with no UI to unblock; `acceptEdits` is permissive
   *  on edits but still asks for Bash; `auto` keeps the flow
   *  uninterrupted for the read-heavy work most chat sessions do. */
  permissionMode: string;
  /** Optional model override. Empty → claude's default. */
  model: string;
}) {
  // Re-render on any chat-store mutation; the slice we actually care
  // about (this tab's runtime + UX state) we read fresh from the
  // store after each notification. `getVersion` is a primitive so
  // useSyncExternalStore stays stable under Object.is.
  useSyncExternalStore(subscribeChat, getVersion, getVersion);
  const tab = getTab(tabId);
  const session = tab?.session ?? null;
  const [localState, setLocalState] = useState<LocalState>({ kind: "idle" });
  // Per-tab draft + attachments are seeded from the tab record on
  // mount (the parent re-keys ChatView per-tab so this initializer
  // runs every tab switch) and pushed back to the record on change.
  const [draft, setDraft] = useState<string>(() => tab?.draft ?? "");
  const [pendingSubmit, setPendingSubmit] = useState(false);
  const [showFind, setShowFind] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [unseenCount, setUnseenCount] = useState(0);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [draftBeforeHistory, setDraftBeforeHistory] = useState<string | null>(
    null,
  );

  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);

  // PRD §4.7 auto-submit countdown — null when no auto-submit is
  // pending, otherwise the wall-clock ms when the seed will fire.
  const [autoSubmitDeadline, setAutoSubmitDeadline] = useState<number | null>(
    null,
  );

  // Convert-to picker open state. The picker reads the current
  // session and dispatches a save-to-target action.
  const [showConvert, setShowConvert] = useState(false);

  // PRD §4.3 image paste + file drop. Each pending attachment is a
  // workspace-relative path we'll inline into the user turn as a
  // markdown image / file reference before sending. The shape lives
  // in chatSession (alongside ChatTab) so it survives tab switches.
  const [attachments, setAttachments] = useState<PendingAttachment[]>(
    () => tab?.attachments ?? [],
  );

  // Persist draft + attachments back to the tab record so switching
  // tabs and switching back finds the in-progress message intact.
  useEffect(() => {
    updateTab(tabId, { draft, attachments });
    // We intentionally write on every change; updateTab is cheap
    // (Map mutation + emit). Persistence to localStorage is debounced
    // by virtue of being a single setItem call per emit — fine.
  }, [tabId, draft, attachments]);

  const feedRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const lastItemCountRef = useRef(0);

  // Auto-grow the composer to fit its content. The old `rows`
  // heuristic counted newlines, so a single long paragraph that
  // word-wrapped stayed one row tall and scrolled out of view.
  // Measuring scrollHeight grows the box for wrapped text too, up to
  // a generous cap (half the window); past that it scrolls internally
  // so the whole draft stays reachable while you type it. Runs on
  // draft change and on tab switch (the parent re-keys per tab, so
  // this remounts and re-fits the restored draft).
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const maxHeight = Math.round(window.innerHeight * 0.5);
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [draft]);

  // Stable per-tab handlers for the transcript rows. ChatItemView is
  // memoized (see below); passing fresh inline closures per item on
  // every render would defeat the memo and re-render the whole feed on
  // each streaming chunk. Reading the session fresh from the store keeps
  // these identity-stable across renders (deps: tabId only).
  const editUserTurn = useCallback((text: string) => {
    setDraft(text);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);
  const regenerateFromAssistant = useCallback(
    (itemId: string) => {
      const s = getTab(tabId)?.session;
      if (!s || s.inFlight || s.exited) return;
      // Find the most recent user turn before this assistant item and
      // copy it back into the input so claude can re-attempt with
      // current context (no truncation — that's a separate fork action).
      const idx = s.items.findIndex((i) => i.id === itemId);
      for (let i = idx - 1; i >= 0; i--) {
        const candidate = s.items[i];
        if (candidate && candidate.kind === "user") {
          setDraft(candidate.text);
          setTimeout(() => inputRef.current?.focus(), 0);
          return;
        }
      }
    },
    [tabId],
  );

  // Auto-scroll: pin to bottom while a turn streams; if the user
  // scrolls up, pause until they hit the jump pill or scroll back
  // down themselves.
  useEffect(() => {
    if (!session) return;
    const feed = feedRef.current;
    if (!feed) return;
    const newItems = session.items.length - lastItemCountRef.current;
    if (autoScroll) {
      feed.scrollTop = feed.scrollHeight;
      setUnseenCount(0);
    } else if (newItems > 0) {
      setUnseenCount((c) => c + newItems);
    }
    lastItemCountRef.current = session.items.length;
  }, [session?.items.length, autoScroll, session]);

  // Detect manual scroll-up to pause auto-scroll.
  useEffect(() => {
    const feed = feedRef.current;
    if (!feed) return;
    const onScroll = () => {
      const atBottom =
        feed.scrollHeight - feed.scrollTop - feed.clientHeight < 32;
      setAutoScroll(atBottom);
      if (atBottom) setUnseenCount(0);
    };
    feed.addEventListener("scroll", onScroll, { passive: true });
    return () => feed.removeEventListener("scroll", onScroll);
  }, []);

  // Cmd+F → toggle find bar. Esc → close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && (e.key === "f" || e.key === "F") && session) {
        e.preventDefault();
        setShowFind((v) => !v);
      } else if (e.key === "Escape" && showFind) {
        setShowFind(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showFind, session]);

  // After a queued turn, the inFlight flag flips off via the result
  // event; that's our cue to drain the queue.
  useEffect(() => {
    if (!session) return;
    if (session.inFlight) return;
    if (session.exited) return;
    if (session.queue.length === 0) return;
    const { next, text } = dequeueTurn(session);
    if (text == null) return;
    const withTurn = addUserTurn(next, text);
    setTabSession(tabId, withTurn);
    void invoke("chat_send", {
      handle: session.meta.handle,
      text,
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      const cur = getTab(tabId)?.session ?? withTurn;
      setTabSession(tabId, applyStderr(cur, message));
    });
  }, [tabId, session?.inFlight, session?.queue.length, session]);

  // Load the slash-command catalog once. It's cwd-relative, so if
  // we don't have a session yet we fall back to the workspace root
  // (the IPC default). Once a session opens we re-fetch for that
  // session's cwd in case it differs.
  useEffect(() => {
    const cwd = session?.meta.cwd ?? "";
    void invoke<SlashCommand[]>("chat_slash_commands", { cwd })
      .then((cmds) => setSlashCommands(cmds))
      .catch(() => setSlashCommands([]));
  }, [session?.meta.cwd]);

  // Open the slash popover when the user starts a message with "/".
  // Close it when the leading "/" is removed.
  useEffect(() => {
    if (draft.startsWith("/")) {
      setSlashOpen(true);
      setSlashFilter(draft.slice(1).split(/\s/, 1)[0] ?? "");
      setSlashIndex(0);
    } else {
      setSlashOpen(false);
    }
  }, [draft]);

  // Auto-submit timer — fires after 3 seconds; canceled if the user
  // types or hits Escape. We tick at 100ms so the countdown chip
  // updates smoothly.
  useEffect(() => {
    if (autoSubmitDeadline === null) return;
    const interval = window.setInterval(() => {
      const remaining = autoSubmitDeadline - Date.now();
      if (remaining <= 0) {
        window.clearInterval(interval);
        setAutoSubmitDeadline(null);
        void submit();
      }
    }, 100);
    return () => window.clearInterval(interval);
    // submit dep is intentionally absent — submit changes per render
    // but we want the firing closure to use the latest version,
    // which it does because the interval callback re-reads from the
    // closure scope on each tick. ESLint can't see that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSubmitDeadline]);

  // Cancel auto-submit on user input or Escape.
  useEffect(() => {
    if (autoSubmitDeadline === null) return;
    const cancel = () => setAutoSubmitDeadline(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        cancel();
        return;
      }
      // Any printable input cancels too — preserves the "you can stop
      // me" user contract.
      if (e.key.length === 1) cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [autoSubmitDeadline]);

  // Listen for Run-in-Console events from other surfaces. PRD §4.7.
  // We seed the input box (and optionally auto-submit after a 3s
  // countdown for read-only seeds).
  useEffect(() => {
    const onSeed = (e: Event) => {
      const detail = (e as CustomEvent<ConsoleRunHerePayload>).detail;
      if (!detail) return;
      const refs = detail.references ?? [];
      const preamble = refs
        .map((r) => `[${r.label}]${r.relPath ? `(${r.relPath})` : ""}`)
        .join(" ");
      const seeded = preamble
        ? `${preamble}\n\n${detail.prompt}`
        : detail.prompt;
      setDraft(seeded);
      // Focus the input so the user can edit before sending.
      setTimeout(() => inputRef.current?.focus(), 0);
      // Auto-submit handling: 3-second countdown the user can cancel
      // by typing or pressing Esc. We implement this as a single
      // setTimeout — if the user touches the input, the timer is
      // cleared in a separate effect below.
      if (detail.auto_submit) {
        setAutoSubmitDeadline(Date.now() + 3000);
      }
    };
    window.addEventListener(CONSOLE_RUN_HERE_EVENT, onSeed);
    return () =>
      window.removeEventListener(CONSOLE_RUN_HERE_EVENT, onSeed);
  }, []);

  const filteredCommands = useMemo(() => {
    if (!slashOpen) return [] as SlashCommand[];
    const q = slashFilter.toLowerCase();
    if (!q) return slashCommands.slice(0, 12);
    return slashCommands
      .filter((c) => c.name.toLowerCase().includes(q))
      .slice(0, 12);
  }, [slashOpen, slashFilter, slashCommands]);

  // History recall (Up/Down on empty input). PRD §3 #22.
  const userTurns = useMemo(() => {
    if (!session) return [] as string[];
    return session.items
      .filter((i): i is Extract<ChatItem, { kind: "user" }> => i.kind === "user")
      .map((i) => i.text);
  }, [session]);

  const startSession = useCallback(async () => {
    if (localState.kind === "starting") return;
    if (session && !session.exited) return;
    if (session && session.exited) {
      try {
        await invoke("chat_close", { handle: session.meta.handle });
      } catch {
        // best-effort
      }
      // Clear the runtime but keep the tab itself.
      try {
        session.dataUnlisten();
      } catch {
        // ignore
      }
      try {
        session.exitUnlisten();
      } catch {
        // ignore
      }
      try {
        session.stderrUnlisten();
      } catch {
        // ignore
      }
      setTabSession(tabId, null);
    }
    setLocalState({ kind: "starting" });
    try {
      // Honor the tab's persisted resumeHint (if any) so a tab
      // restored from localStorage continues its prior conversation.
      const resumeHint = getTab(tabId)?.resumeHint;
      const tabCwd = getTab(tabId)?.cwd ?? "";
      const open = await invoke<OpenResult>("chat_open", {
        args: {
          cwd: tabCwd,
          model: model ?? "",
          permission_mode: permissionMode || "auto",
          resume_id: resumeHint?.sessionId ?? "",
        },
      });
      let dataUnlisten: UnlistenFn | null = null;
      let exitUnlisten: UnlistenFn | null = null;
      let stderrUnlisten: UnlistenFn | null = null;
      const meta: ChatSessionMeta = {
        handle: open.handle,
        binary_path: open.binary_path,
        cwd: open.cwd,
        argv: open.argv,
        transcriptMdRel: open.transcript_md_rel ?? undefined,
      };
      const initial: ChatSession = {
        meta,
        items: [],
        inFlight: false,
        queue: [],
        exited: false,
        // Real listeners attached below; placeholders here so the
        // store always carries the correct shape.
        dataUnlisten: () => undefined,
        exitUnlisten: () => undefined,
        stderrUnlisten: () => undefined,
      };
      setTabSession(tabId, initial);
      // Record into Recents so the transcript shows up in the sidebar
      // and Cmd+Shift+F. Skip if the transcript path didn't get set
      // (rare — only when transcript creation failed).
      if (open.transcript_md_rel) {
        const filename = open.transcript_md_rel.split("/").pop() ?? "session";
        recordRecent(open.transcript_md_rel, `Console — ${filename.replace(/\.md$/, "")}`);
      }
      dataUnlisten = await listen<unknown>(
        `chat:${open.handle}:event`,
        (e) => {
          // Listeners are tab-scoped via the closed-over tabId. We
          // verify the runtime handle matches before applying so a
          // stale listener (after the tab spawned a fresh session)
          // doesn't poison the new one.
          const cur = getTab(tabId)?.session;
          if (!cur || cur.meta.handle !== open.handle) return;
          const wasInFlight = cur.inFlight;
          const next = applyEvent(cur, e.payload);
          setTabSession(tabId, next);
          // PRD §4.3.1 backgrounding: if a turn finished while the
          // user is on a different tab, bump the unseen pip on this
          // tab so the strip surfaces "1 done" until they look.
          if (wasInFlight && !next.inFlight && getActiveTabId() !== tabId) {
            bumpUnseenCompletion(tabId);
          }
        },
      );
      exitUnlisten = await listen<{ reason?: string }>(
        `chat:${open.handle}:exit`,
        (e) => {
          const cur = getTab(tabId)?.session;
          if (!cur || cur.meta.handle !== open.handle) return;
          setTabSession(tabId, applyExit(cur, e.payload?.reason));
        },
      );
      stderrUnlisten = await listen<string>(
        `chat:${open.handle}:stderr`,
        (e) => {
          const cur = getTab(tabId)?.session;
          if (!cur || cur.meta.handle !== open.handle) return;
          setTabSession(tabId, applyStderr(cur, e.payload));
        },
      );
      // Replace with the real unlistens.
      const cur = getTab(tabId)?.session;
      if (cur && cur.meta.handle === open.handle) {
        setTabSession(tabId, {
          ...cur,
          dataUnlisten: dataUnlisten ?? (() => undefined),
          exitUnlisten: exitUnlisten ?? (() => undefined),
          stderrUnlisten: stderrUnlisten ?? (() => undefined),
        });
      }
      setLocalState({ kind: "idle" });
      // Focus the input so the user can type immediately.
      setTimeout(() => inputRef.current?.focus(), 0);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setLocalState({ kind: "error", message });
    }
  }, [tabId, session, localState.kind, model, permissionMode]);

  const submit = useCallback(async () => {
    const text = draft.trim();
    // Allow attachments-only sends (e.g., "look at this screenshot"
    // without typing). If both are empty, no-op.
    if (!text && attachments.length === 0) return;
    if (!session) {
      // First send before session opened — open + queue.
      setPendingSubmit(true);
      await startSession();
      return;
    }
    if (session.exited) return;
    // Build the final message: prepend each attachment as a markdown
    // reference. Images use ![filename](relPath) so claude reads
    // them via its image-reading capability; non-images go as plain
    // file references for the model to choose to Read.
    const refLines = attachments.map((a) =>
      a.kind === "image"
        ? `![${a.filename}](${a.relPath})`
        : `[${a.filename}](${a.relPath})`,
    );
    const finalText = refLines.length > 0
      ? `${refLines.join("\n")}\n\n${text}`.trim()
      : text;
    setDraft("");
    setAttachments([]);
    setHistoryIndex(null);
    setDraftBeforeHistory(null);
    if (session.inFlight) {
      setTabSession(tabId, enqueueTurn(session, finalText));
      return;
    }
    setTabSession(tabId, addUserTurn(session, finalText));
    // First user turn drives the tab strip's auto-label so the user
    // can tell tabs apart at a glance. No-op if the tab was already
    // renamed.
    autoLabelTabFromFirstTurn(tabId, finalText);
    try {
      await invoke("chat_send", { handle: session.meta.handle, text: finalText });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const cur = getTab(tabId)?.session ?? session;
      setTabSession(tabId, applyStderr(cur, message));
    }
  }, [tabId, draft, session, startSession, attachments]);

  // After startSession resolves, if we had a pending submit, fire it.
  useEffect(() => {
    if (!pendingSubmit) return;
    if (!session) return;
    setPendingSubmit(false);
    void submit();
  }, [pendingSubmit, session, submit]);

  const cancelInFlight = useCallback(async () => {
    if (!session) return;
    try {
      await invoke("chat_cancel", { handle: session.meta.handle });
    } catch {
      // best-effort
    }
  }, [session]);

  /**
   * End the runtime on this tab and return to the empty state, but
   * keep the tab itself in the strip. The tab strip's "x" button is
   * the way to fully close a tab; "end session" here is the lighter
   * "reset this tab and start over" affordance.
   */
  const dismissSession = useCallback(async () => {
    if (!session) return;
    if (session.inFlight && !session.exited) {
      const ok = window.confirm(
        "End this session? Claude is mid-turn — the in-flight response will be lost.",
      );
      if (!ok) return;
    }
    try {
      await invoke("chat_close", { handle: session.meta.handle });
    } catch {
      // best-effort
    }
    try {
      session.dataUnlisten();
    } catch {
      // ignore
    }
    try {
      session.exitUnlisten();
    } catch {
      // ignore
    }
    try {
      session.stderrUnlisten();
    } catch {
      // ignore
    }
    setTabSession(tabId, null);
    // Drop the resume hint so the next start is genuinely fresh —
    // user explicitly asked to end the session.
    updateTab(tabId, { resumeHint: undefined });
    setLocalState({ kind: "idle" });
    setDraft("");
    setAttachments([]);
    setHistoryIndex(null);
    setDraftBeforeHistory(null);
    setShowConvert(false);
    setShowFind(false);
  }, [tabId, session]);

  /**
   * Land a pasted/dropped binary into the workspace `attachments/`
   * folder via content_write_attachment. Returns the rel-path on
   * success. Errors bubble up as a stderr-style chat item so the
   * user sees what went wrong without losing the in-flight session.
   */
  const writeAttachment = useCallback(
    async (
      filename: string,
      bytes: ArrayBuffer,
    ): Promise<string | null> => {
      try {
        const rel = await invoke<string>("content_write_attachment", {
          // Anchor the attachment under the active transcript so
          // delete-the-doc cleanup picks it up. Falls back to a
          // "console" bucket if no transcript path exists yet.
          docRelPath:
            session?.meta.transcriptMdRel ??
            "areas/console-sessions/sessions/inbox.md",
          filename,
          bytes: Array.from(new Uint8Array(bytes)),
        });
        return rel;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const cur = getTab(tabId)?.session;
        if (cur) setTabSession(tabId, applyStderr(cur, `attachment write failed: ${message}`));
        return null;
      }
    },
    [tabId, session],
  );

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = Array.from(e.clipboardData?.items ?? []);
      const imageItems = items.filter((it) => it.type.startsWith("image/"));
      if (imageItems.length === 0) return;
      e.preventDefault();
      for (const it of imageItems) {
        const file = it.getAsFile();
        if (!file) continue;
        const buf = await file.arrayBuffer();
        const ext = (file.type.split("/")[1] ?? "png").toLowerCase();
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const filename = `paste-${stamp}.${ext}`;
        const rel = await writeAttachment(filename, buf);
        if (rel) {
          setAttachments((a) => [...a, { kind: "image", relPath: rel, filename }]);
        }
      }
    },
    [writeAttachment],
  );

  const handleDrop = useCallback(
    async (e: React.DragEvent<HTMLTextAreaElement>) => {
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      e.preventDefault();
      for (const file of files) {
        const buf = await file.arrayBuffer();
        const rel = await writeAttachment(file.name, buf);
        if (rel) {
          const kind: PendingAttachment["kind"] = file.type.startsWith("image/")
            ? "image"
            : "file";
          setAttachments((a) => [...a, { kind, relPath: rel, filename: file.name }]);
        }
      }
    },
    [writeAttachment],
  );

  const removeAttachment = (idx: number) =>
    setAttachments((a) => a.filter((_, i) => i !== idx));

  const acceptSlash = (cmd: SlashCommand) => {
    // Replace the leading slug with the chosen command + a trailing
    // space, but preserve any args the user already typed.
    const m = draft.match(/^\/(\S*)(.*)$/s);
    const rest = m?.[2] ?? "";
    setDraft(`/${cmd.name}${rest.startsWith(" ") ? rest : ` ${rest}`}`);
    setSlashOpen(false);
  };

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen && filteredCommands.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((i) => Math.min(filteredCommands.length - 1, i + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        const cmd = filteredCommands[slashIndex];
        if (cmd) acceptSlash(cmd);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashOpen(false);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.altKey) {
      // Cmd/Ctrl+Enter = submit too. Plain Enter inserts newline
      // unless the input is short — that gives multi-line drafts a
      // chance, which the PRD wants. We follow the simpler rule for
      // now: Enter submits, Shift+Enter newline.
      e.preventDefault();
      void submit();
      return;
    }
    if (e.key === "ArrowUp" && !e.shiftKey) {
      // Up on empty input → recall most recent user turn.
      if (
        draft.length === 0 &&
        userTurns.length > 0 &&
        historyIndex === null
      ) {
        e.preventDefault();
        const idx = userTurns.length - 1;
        setHistoryIndex(idx);
        setDraftBeforeHistory(draft);
        setDraft(userTurns[idx]);
        return;
      }
      if (historyIndex !== null && historyIndex > 0) {
        e.preventDefault();
        const next = historyIndex - 1;
        setHistoryIndex(next);
        setDraft(userTurns[next]);
      }
      return;
    }
    if (e.key === "ArrowDown" && !e.shiftKey) {
      if (historyIndex === null) return;
      if (historyIndex >= userTurns.length - 1) {
        e.preventDefault();
        setHistoryIndex(null);
        setDraft(draftBeforeHistory ?? "");
        setDraftBeforeHistory(null);
        return;
      }
      e.preventDefault();
      const next = historyIndex + 1;
      setHistoryIndex(next);
      setDraft(userTurns[next]);
    } else if (e.key === "Escape" && historyIndex !== null) {
      e.preventDefault();
      setHistoryIndex(null);
      setDraft(draftBeforeHistory ?? "");
      setDraftBeforeHistory(null);
    }
  };

  const isRunning = session !== null && !session.exited;
  const isStopped = session !== null && session.exited;
  const inFlight = session?.inFlight ?? false;

  return (
    <div className="cos-chat" role="region" aria-label="Claude Code chat">
      <ChatHeader
        meta={session?.meta ?? null}
        inFlight={inFlight}
        queueDepth={session?.queue.length ?? 0}
        onCancel={() => void cancelInFlight()}
        onToggleFind={() => setShowFind((v) => !v)}
        onConvert={
          session && session.items.length > 0
            ? () => setShowConvert(true)
            : null
        }
      />
      {showConvert && session && (
        <ConvertToPicker
          session={session}
          onClose={() => setShowConvert(false)}
        />
      )}
      {showFind && (
        <FindBar
          query={findQuery}
          onChange={setFindQuery}
          onClose={() => {
            setShowFind(false);
            setFindQuery("");
          }}
        />
      )}
      <div className="cos-chat-feed" ref={feedRef}>
        {!session && localState.kind !== "starting" && <EmptyState />}
        {localState.kind === "starting" && (
          <div className="cos-chat-status">spinning up claude…</div>
        )}
        {localState.kind === "error" && (
          <div className="cos-chat-error" role="alert">
            <strong>Couldn't start chat session.</strong>
            <p>{localState.message}</p>
            <button
              type="button"
              className="cos-btn"
              onClick={() => setLocalState({ kind: "idle" })}
            >
              try again
            </button>
          </div>
        )}
        {session?.items.map((item) => (
          <ChatItemView
            key={item.id}
            item={item}
            findQuery={findQuery}
            onEditUserTurn={editUserTurn}
            onRegenerateAssistant={regenerateFromAssistant}
          />
        ))}
        {isStopped && (
          <div className="cos-chat-status-banner" role="status">
            Session ended
            {session?.exitReason ? ` (${session.exitReason})` : ""}.
          </div>
        )}
      </div>
      {!autoScroll && unseenCount > 0 && (
        <button
          type="button"
          className="cos-chat-jump-pill"
          onClick={() => {
            const feed = feedRef.current;
            if (feed) feed.scrollTop = feed.scrollHeight;
            setAutoScroll(true);
            setUnseenCount(0);
          }}
        >
          <ArrowDown size={12} strokeWidth={2} aria-hidden /> jump to latest (
          {unseenCount} new)
        </button>
      )}
      {autoSubmitDeadline !== null && (
        <div className="cos-chat-autosubmit" role="status">
          Sending in{" "}
          {Math.max(0, Math.ceil((autoSubmitDeadline - Date.now()) / 1000))}s
          —
          <button
            type="button"
            className="cos-btn-link"
            onClick={() => setAutoSubmitDeadline(null)}
          >
            cancel
          </button>
          (or press Esc / type to cancel)
        </div>
      )}
      {slashOpen && filteredCommands.length > 0 && (
        <div className="cos-chat-slash-popover" role="listbox">
          {filteredCommands.map((cmd, idx) => (
            <button
              type="button"
              key={cmd.name}
              role="option"
              aria-selected={idx === slashIndex}
              className={`cos-chat-slash-row${
                idx === slashIndex ? " is-active" : ""
              }`}
              onMouseEnter={() => setSlashIndex(idx)}
              onClick={() => acceptSlash(cmd)}
            >
              <span className="cos-chat-slash-name">/{cmd.name}</span>
              {cmd.description && (
                <span className="cos-chat-slash-desc">
                  {cmd.description}
                </span>
              )}
              <span
                className={`cos-chat-slash-source cos-chat-slash-source-${cmd.source}`}
                title={`source: ${cmd.source}`}
              >
                {cmd.source}
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="cos-chat-input">
        {attachments.length > 0 && (
          <div className="cos-chat-attachments">
            {attachments.map((a, idx) => (
              <span
                key={`${a.relPath}-${idx}`}
                className="cos-chat-attachment-chip"
                title={a.relPath}
              >
                {a.kind === "image" ? (
                  <ImageIcon size={12} strokeWidth={1.75} aria-hidden />
                ) : null}
                <span>{a.filename}</span>
                <button
                  type="button"
                  className="cos-btn-icon"
                  onClick={() => removeAttachment(idx)}
                  aria-label={`Remove ${a.filename}`}
                >
                  <X size={12} strokeWidth={1.75} aria-hidden />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKey}
          onPaste={(e) => void handlePaste(e)}
          onDrop={(e) => void handleDrop(e)}
          onDragOver={(e) => e.preventDefault()}
          placeholder={
            session
              ? inFlight
                ? "queue a follow-up…"
                : "message claude — Enter to send, Shift+Enter newline"
              : "message claude — first send starts the session"
          }
          rows={1}
          disabled={localState.kind === "starting" || isStopped}
        />
        <div className="cos-chat-input-actions">
          {inFlight ? (
            <button
              type="button"
              className="cos-btn cos-btn-ghost"
              onClick={() => void cancelInFlight()}
              title="Stop the in-flight turn"
            >
              <Square size={14} strokeWidth={1.75} aria-hidden /> stop
            </button>
          ) : (
            <button
              type="button"
              className="cos-btn cos-btn-primary"
              onClick={() => void submit()}
              disabled={
                !draft.trim() || localState.kind === "starting" || isStopped
              }
            >
              <Send size={14} strokeWidth={1.75} aria-hidden /> send
            </button>
          )}
          {(isRunning || isStopped) && (
            <button
              type="button"
              className="cos-btn cos-btn-ghost"
              onClick={() => void dismissSession()}
              title={
                isStopped
                  ? "Drop the ended session and clear the surface"
                  : "End this session and start fresh"
              }
            >
              {isStopped ? "dismiss" : "end session"}
            </button>
          )}
          {isRunning && session?.queue && session.queue.length > 0 && (
            <span className="cos-chat-queue-chip" title="queued messages">
              {session.queue.length} queued
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function ChatHeader({
  meta,
  inFlight,
  queueDepth,
  onCancel,
  onToggleFind,
  onConvert,
}: {
  meta: ChatSessionMeta | null;
  inFlight: boolean;
  queueDepth: number;
  onCancel: () => void;
  onToggleFind: () => void;
  onConvert: (() => void) | null;
}) {
  return (
    <div className="cos-chat-chips">
      {meta?.model && (
        <span className="cos-chip" title="Model">
          <span className="cos-chip-label">model</span>
          <span className="cos-chip-value">{meta.model}</span>
        </span>
      )}
      {meta?.permissionMode && (
        <span className="cos-chip" title="Permission mode">
          <span className="cos-chip-label">mode</span>
          <span className="cos-chip-value">{meta.permissionMode}</span>
        </span>
      )}
      {meta?.cwd && (
        <span className="cos-chip" title={`Working dir: ${meta.cwd}`}>
          <span className="cos-chip-label">cwd</span>
          <span className="cos-chip-value">{shortPath(meta.cwd)}</span>
        </span>
      )}
      {typeof meta?.contextPercent === "number" && (
        <span
          className={`cos-chip${
            (meta.contextPercent ?? 0) >= 90
              ? " is-critical"
              : (meta.contextPercent ?? 0) >= 75
                ? " is-warn"
                : ""
          }`}
          title="Context window usage"
        >
          <span className="cos-chip-label">ctx</span>
          <span className="cos-chip-value">{meta.contextPercent}%</span>
        </span>
      )}
      {typeof meta?.totalCostUsd === "number" && meta.totalCostUsd > 0 && (
        <span className="cos-chip" title="Session cost">
          <span className="cos-chip-label">cost</span>
          <span className="cos-chip-value">
            ${meta.totalCostUsd.toFixed(4)}
          </span>
        </span>
      )}
      {inFlight && (
        <button
          type="button"
          className="cos-chat-inflight-chip"
          onClick={onCancel}
          title="In-flight turn — click to stop"
        >
          <span className="cos-spin" aria-hidden /> running
          {queueDepth > 0 ? ` · ${queueDepth} queued` : ""}
        </button>
      )}
      <button
        type="button"
        className="cos-btn cos-btn-ghost cos-chat-find-btn"
        onClick={onToggleFind}
        title="Find in conversation (⌘F)"
      >
        <Search size={14} strokeWidth={1.75} aria-hidden />
      </button>
      {onConvert && (
        <button
          type="button"
          className="cos-btn cos-btn-ghost"
          onClick={onConvert}
          title="Convert this session to a doc, task, or note"
        >
          <ArrowUpRight size={14} strokeWidth={1.75} aria-hidden />
          convert
        </button>
      )}
    </div>
  );
}

/**
 * PRD-116 §4.5 "Convert to" — small picker that lets the user
 * promote the current Console session into a curated artifact:
 *   - Task (with this conversation summarized as the task notes)
 *   - 1:1 prep doc reference
 *   - Project note
 *
 * Phase-3 minimum: we wire the Task path (creates a v1 task with
 * the transcript path linked in the notes). The other two land via
 * the same pattern in follow-ups; they're just different write
 * targets behind the same picker.
 */
function ConvertToPicker({
  session,
  onClose,
}: {
  session: ChatSession;
  onClose: () => void;
}) {
  const transcript = session.meta.transcriptMdRel;
  const summary = useMemo(() => {
    // Use the first user turn as the seed for the task title.
    const firstUser = session.items.find((i) => i.kind === "user");
    if (firstUser && firstUser.kind === "user") {
      const t = firstUser.text.trim().split("\n")[0];
      return t.length > 80 ? `${t.slice(0, 77)}…` : t;
    }
    return "Console session";
  }, [session.items]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const convertToTask = async () => {
    setBusy(true);
    setError(null);
    try {
      const notes = transcript
        ? `Console session — ${transcript}`
        : "Console session";
      await invoke("v1_tasks_create", {
        input: {
          title: summary,
          notes,
          tags: ["work", "console"],
          priority: "medium",
        },
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const openTranscriptInEditor = () => {
    if (!transcript) return;
    window.dispatchEvent(
      new CustomEvent("cos:open-doc", {
        detail: {
          relPath: transcript,
          label: `Console — ${summary}`,
        },
      }),
    );
    onClose();
  };

  return (
    <div className="cos-chat-convert" role="dialog" aria-label="Convert session">
      <div className="cos-chat-convert-head">
        <span>Convert this session</span>
        <button
          type="button"
          className="cos-btn-icon"
          onClick={onClose}
          aria-label="Close"
        >
          <X size={14} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
      <div className="cos-chat-convert-body">
        <button
          type="button"
          className="cos-chat-convert-row"
          onClick={() => void convertToTask()}
          disabled={busy}
        >
          <strong>Create a task</strong>
          <span>
            New task in Tasks with the transcript linked in the notes.
          </span>
        </button>
        <button
          type="button"
          className="cos-chat-convert-row"
          onClick={openTranscriptInEditor}
          disabled={!transcript}
        >
          <strong>Open transcript in the editor</strong>
          <span>
            View the session's <code>.md</code> transcript — link it
            from a 1:1, project, or weekly review.
          </span>
        </button>
      </div>
      {error && <p className="cos-chat-convert-error">{error}</p>}
    </div>
  );
}

function FindBar({
  query,
  onChange,
  onClose,
}: {
  query: string;
  onChange: (v: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="cos-chat-find-bar" role="search">
      <Search size={14} strokeWidth={1.75} aria-hidden />
      <input
        type="text"
        value={query}
        onChange={(e) => onChange(e.target.value)}
        placeholder="find in conversation"
        autoFocus
      />
      <button
        type="button"
        className="cos-btn-icon"
        onClick={onClose}
        aria-label="Close find"
      >
        <X size={14} strokeWidth={1.75} aria-hidden />
      </button>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="cos-chat-empty">
      <p className="cos-section-lede">
        Stream-json chat with claude — same binary, same skills, same{" "}
        <code>CLAUDE.md</code>, but with structured tool cards and inline
        diffs instead of raw terminal output.
      </p>
      <p className="cos-helper-text">
        Type a message below; the first send spawns the session. Every
        turn shows tool calls as collapsible cards, file edits as
        inline diffs, and tracks per-session cost + token usage.
      </p>
    </div>
  );
}

const ChatItemView = memo(function ChatItemView({
  item,
  findQuery,
  onEditUserTurn,
  onRegenerateAssistant,
}: {
  item: ChatItem;
  findQuery: string;
  onEditUserTurn: (text: string) => void;
  onRegenerateAssistant: (itemId: string) => void;
}) {
  if (item.kind === "user") {
    return (
      <div
        className={`cos-chat-turn cos-chat-turn-user${
          highlightMatches(item.text, findQuery) ? " is-find-hit" : ""
        }`}
      >
        <div className="cos-chat-turn-meta">
          You
          <button
            type="button"
            className="cos-chat-turn-action"
            onClick={() => onEditUserTurn(item.text)}
            title="Copy this turn back into the input for editing"
          >
            edit ↺
          </button>
        </div>
        <div className="cos-chat-turn-body">{item.text}</div>
      </div>
    );
  }
  if (item.kind === "system") {
    return (
      <div
        className={`cos-chat-system cos-chat-system-${item.level}${
          highlightMatches(item.message, findQuery) ? " is-find-hit" : ""
        }`}
      >
        {item.message}
      </div>
    );
  }
  // Assistant — render blocks in order. Tool cards interleave with
  // text; thinking blocks render in a muted region.
  return (
    <div
      className={`cos-chat-turn cos-chat-turn-assistant${
        item.blocks.some((b) =>
          b.kind === "text"
            ? highlightMatches(b.text, findQuery)
            : b.kind === "thinking"
              ? highlightMatches(b.text, findQuery)
              : false,
        )
          ? " is-find-hit"
          : ""
      }`}
    >
      <div className="cos-chat-turn-meta">
        Claude
        <button
          type="button"
          className="cos-chat-turn-action"
          onClick={() => onRegenerateAssistant(item.id)}
          title="Re-run the previous user turn to regenerate this response"
        >
          regenerate ↻
        </button>
      </div>
      <div className="cos-chat-turn-body">
        {item.blocks.map((block, idx) => {
          if (block.kind === "text") {
            return <ChatMarkdown key={idx} markdown={block.text} />;
          }
          if (block.kind === "thinking") {
            return (
              <details key={idx} className="cos-chat-thinking">
                <summary>thinking</summary>
                <div>{block.text}</div>
              </details>
            );
          }
          return <ToolCallCard key={idx} call={block.call} />;
        })}
      </div>
    </div>
  );
});

function highlightMatches(text: string, query: string): boolean {
  if (!query.trim()) return false;
  return text.toLowerCase().includes(query.toLowerCase());
}

function shortPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 2) return p;
  return parts.slice(-2).join("/");
}
