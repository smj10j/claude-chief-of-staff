/**
 * PRD-116 Phase 2.5 + Phase 3 — chat session state.
 *
 * Phase 2.5 shipped a single-session store: one `active` ChatSession
 * for the whole app. Phase 3 lights up the tab strip — multiple
 * concurrent sessions, each with its own transport, transcript, cwd,
 * and per-tab UX state (draft, attachments, etc.). The Rust backend
 * has been multi-session-capable since Phase 2.5 (HashMap of handles),
 * so this is a pure frontend lift.
 *
 * Shape:
 *   - `tabs` is a Map keyed by a stable `tabId` (uuid). The runtime
 *     `ChatSession` lives on the tab; null until the tab's first
 *     `chat_open`. A persisted-but-not-yet-opened tab is a "ghost" —
 *     it shows up in the strip and reopens with `--resume` on first
 *     activation.
 *   - `tabOrder` preserves left-to-right ordering for the strip.
 *   - `activeTabId` is the tab whose ChatView is currently mounted.
 *   - Per-tab UX state (`draft`, `attachments`) lives on the tab so a
 *     tab switch round-trip restores what the user was typing.
 *
 * Backward-compat: `getActiveChat`, `setActiveChat`, `subscribeChat`,
 * `disposeActiveChat` keep their existing semantics — they operate on
 * the active tab's session. Reducer functions (`applyEvent`,
 * `applyStderr`, `applyExit`, `addUserTurn`, `enqueueTurn`,
 * `dequeueTurn`) are unchanged; they still take a `ChatSession` in
 * and return one out, callable from anywhere.
 *
 * Persistence: tab metadata (label, cwd, transcript path, claude
 * session id) is mirrored to localStorage on every change so a
 * restart can rehydrate the strip. We do *not* persist the runtime
 * itself — the child processes die with the app; reopened tabs spawn
 * a fresh `claude` with `--resume <sessionId>` lazily on first use.
 *
 * Event taxonomy (frontend-facing, mapped from Claude Code's
 * stream-json shape):
 *   - `system.init` — first event, captures session_id, model,
 *     permission_mode, cwd, mcp servers, tool list. Drives chip
 *     row and the resume flow.
 *   - `assistant.message` — claude's response, possibly streamed.
 *     Content can be text, tool_use, or thinking. Its `usage` is the
 *     prompt size of that one API call, which drives the context chip.
 *   - `user.message` — echo of what we sent (claude includes
 *     processed user input in its event stream).
 *   - `tool_result` — the tool's response, paired with a tool_use
 *     by `tool_use_id`. We attach to the originating tool-call
 *     item rather than rendering as a sibling.
 *   - `result` — terminal event for a turn: total_cost_usd (session
 *     total, carried across `--resume`), modelUsage (per-model cost,
 *     price basis, context window), duration. Updates the chip row.
 *   - `stderr` — any line claude writes to stderr; surfaced as a
 *     red-edged banner in the renderer.
 *   - `raw` — non-JSON line (rare; happens during launch failures).
 *   - `exit` — child has exited; the surface stops accepting input.
 */

import type { UnlistenFn } from "@tauri-apps/api/event";

export type ChatItemId = string;
export type TabId = string;

export type ToolCall = {
  id: string;
  name: string;
  input: unknown;
  /** Result content. Set when a `tool_result` event arrives that
   *  references this tool_use's id. `null` while in flight. */
  result: string | null;
  /** True when the tool returned an error result. */
  isError: boolean;
};

/**
 * Anything in the conversation feed renders from one of these
 * variants. `id` is unique within a session; we use it as the React
 * key when rendering the list.
 */
export type ChatItem =
  | {
      id: ChatItemId;
      kind: "user";
      text: string;
      ts: number;
    }
  | {
      id: ChatItemId;
      kind: "assistant";
      /** Plain-text portions of the assistant message, joined in
       *  the order they appeared in the stream. We keep the joined
       *  string + a list of tool calls separately so the renderer
       *  can interleave them in the right positions. */
      blocks: AssistantBlock[];
      ts: number;
    }
  | {
      id: ChatItemId;
      kind: "system";
      message: string;
      level: "info" | "warn" | "error";
      ts: number;
    };

export type AssistantBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; call: ToolCall };

export type ChatSessionMeta = {
  handle: string;
  binary_path: string;
  cwd: string;
  argv: string[];
  /** Workspace-relative path of the `.md` transcript. The `.jsonl`
   *  companion lives at the same stem with the `.md`→`.jsonl` swap.
   *  Set at open time; null only when transcript creation failed. */
  transcriptMdRel?: string;
  /** Set once the `system.init` event arrives. */
  sessionId?: string;
  model?: string;
  permissionMode?: string;
  mcpServers?: { name: string; status?: string }[];
  /** Session total from the latest `result` event. Claude Code prices
   *  it from its own per-model rate table, so we never keep one here. */
  totalCostUsd?: number;
  /** Per-model breakdown of `totalCostUsd` (`result.modelUsage`),
   *  costliest first. */
  modelCosts?: ModelCost[];
  /** Prompt size of the latest main-thread API call: uncached input +
   *  cache reads + cache writes. */
  contextTokens?: number;
  /** Context window of the session's model, as Claude Code reports it
   *  in `modelUsage`. Unknown until the first `result` event. */
  contextWindow?: number;
  /** contextTokens / contextWindow, rounded. */
  contextPercent?: number;
};

export type ModelCost = {
  model: string;
  /** Claude Code's resolved model id, when it differs from the key. */
  canonicalModel?: string;
  costUsd: number;
  /** Which rates priced this model: "list" (Anthropic list price),
   *  "managed" (org managed-settings `modelPricing`), or "unknown" (no
   *  rate matched; Claude Code guessed at its default model's rate).
   *  Absent on older Claude Code versions. */
  costBasis?: string;
  contextWindow?: number;
};

export type ChatSession = {
  meta: ChatSessionMeta;
  items: ChatItem[];
  /** True between user-turn submission and the next `result` event.
   *  The send button flips to a stop button while this is true. */
  inFlight: boolean;
  /** Queued user turns that should fire after the in-flight turn
   *  finishes. PRD §4.3 "Queued input." */
  queue: string[];
  /** True after `exit` event arrives. */
  exited: boolean;
  exitReason?: string;
  /** Last stderr line, if any — surfaced as a red-edged banner. */
  stderr?: string;
  dataUnlisten: UnlistenFn;
  exitUnlisten: UnlistenFn;
  stderrUnlisten: UnlistenFn;
};

export type PendingAttachment = {
  kind: "image" | "file";
  relPath: string;
  filename: string;
};

/**
 * One entry in the tab strip. The runtime `session` is null when the
 * tab was rehydrated from persistence and hasn't been reopened yet
 * ("ghost" tab). When the user switches to a ghost tab the surface
 * spawns a `claude` child with `--resume <sessionId>` if one is
 * remembered, or starts fresh otherwise.
 */
export type ChatTab = {
  tabId: TabId;
  /** Display label in the tab strip. Auto-derived from the first
   *  user turn's text or the transcript filename; user can rename. */
  label: string;
  /** Working directory the session is rooted at. Empty string means
   *  "use the workspace default." */
  cwd: string;
  /** Per-tab live runtime. Null until the first chat_open. */
  session: ChatSession | null;
  /** Hint to drive `--resume` when reopening a ghost. */
  resumeHint?: { sessionId: string; transcriptMdRel: string };
  /** Per-tab UX state — preserved across tab switches so the user's
   *  in-progress draft doesn't vanish when they pop over to another
   *  tab and come back. */
  draft: string;
  attachments: PendingAttachment[];
  /** Counter for completed turns the user hasn't seen because they
   *  were on a different tab when the result event arrived. The tab
   *  strip uses this for the "1 done" pip. Cleared on tab activate. */
  unseenCompletions: number;
};

const TAB_PERSIST_KEY = "cos.console.tabs.v1";

let tabs = new Map<TabId, ChatTab>();
let tabOrder: TabId[] = [];
let cachedTabIds: TabId[] = [];
let activeTabId: TabId | null = null;
let version = 0;
const listeners = new Set<() => void>();

let persistEnabled = true;

function emit(): void {
  // Snapshot the tab-id list once per emit so React's
  // useSyncExternalStore sees a stable reference between mutations
  // (new array on every read would infinite-loop).
  cachedTabIds = [...tabOrder];
  version += 1;
  if (persistEnabled) persistTabs();
  for (const fn of listeners) fn();
}

// ── Tab management ─────────────────────────────────────────────────

export function getActiveTabId(): TabId | null {
  return activeTabId;
}

export function setActiveTabId(id: TabId | null): void {
  if (activeTabId === id) return;
  activeTabId = id;
  // Clear the unseen-completions pip when a tab becomes active —
  // the user is now looking at it.
  if (id) {
    const tab = tabs.get(id);
    if (tab && tab.unseenCompletions > 0) {
      tabs.set(id, { ...tab, unseenCompletions: 0 });
    }
  }
  emit();
}

export function getTabIds(): TabId[] {
  return cachedTabIds;
}

/**
 * Monotonically-incrementing counter that ticks on every store
 * mutation. Useful as a `getSnapshot` for `useSyncExternalStore`
 * when a component wants to re-render on *any* change (vs. one
 * specific slice). Primitive return → safe under Object.is.
 */
export function getVersion(): number {
  return version;
}

export function getTab(id: TabId): ChatTab | null {
  return tabs.get(id) ?? null;
}

/**
 * Aggregate signal for the sidebar badge: how many tabs have an
 * in-flight turn right now? Polled by SyncExternalStore subscribers.
 */
export function getInFlightCount(): number {
  let n = 0;
  for (const tab of tabs.values()) {
    if (tab.session && tab.session.inFlight) n += 1;
  }
  return n;
}

/** Total unseen-completion pip count across tabs. */
export function getUnseenCount(): number {
  let n = 0;
  for (const tab of tabs.values()) n += tab.unseenCompletions;
  return n;
}

export type CreateTabOptions = {
  label?: string;
  cwd?: string;
  resumeHint?: ChatTab["resumeHint"];
  /** When true, skip flipping `activeTabId` to the new tab. Used by
   *  rehydration so we don't override a separately-restored active. */
  silent?: boolean;
};

export function createTab(opts: CreateTabOptions = {}): TabId {
  const tabId = makeTabId();
  const tab: ChatTab = {
    tabId,
    label: opts.label?.trim() || "new session",
    cwd: opts.cwd ?? "",
    session: null,
    resumeHint: opts.resumeHint,
    draft: "",
    attachments: [],
    unseenCompletions: 0,
  };
  tabs.set(tabId, tab);
  tabOrder.push(tabId);
  if (!opts.silent && activeTabId === null) {
    activeTabId = tabId;
  }
  emit();
  return tabId;
}

export function closeTab(id: TabId): void {
  const tab = tabs.get(id);
  if (!tab) return;
  if (tab.session) {
    safeUnlisten(tab.session.dataUnlisten);
    safeUnlisten(tab.session.exitUnlisten);
    safeUnlisten(tab.session.stderrUnlisten);
  }
  // Remember the closed tab's position so we can pick a sensible
  // neighbor for the new active tab — the one to the right wins
  // (matches browser tab-close behavior), else fall back to the new
  // last tab if we just closed the rightmost.
  const closedIdx = tabOrder.indexOf(id);
  tabs.delete(id);
  tabOrder = tabOrder.filter((x) => x !== id);
  if (activeTabId === id) {
    if (tabOrder.length === 0) {
      activeTabId = null;
    } else {
      const nextIdx = Math.min(closedIdx, tabOrder.length - 1);
      activeTabId = tabOrder[nextIdx];
    }
  }
  emit();
}

/** Replace a tab's fields. Patch is shallow-merged. */
export function updateTab(id: TabId, patch: Partial<ChatTab>): void {
  const tab = tabs.get(id);
  if (!tab) return;
  tabs.set(id, { ...tab, ...patch });
  emit();
}

/** Convenience: replace the runtime ChatSession on a tab. */
export function setTabSession(id: TabId, session: ChatSession | null): void {
  updateTab(id, { session });
}

/** Cycle to the next or previous tab in the strip, wrapping around. */
export function cycleTab(direction: 1 | -1): void {
  if (tabOrder.length < 2) return;
  const idx = activeTabId ? tabOrder.indexOf(activeTabId) : -1;
  if (idx < 0) {
    setActiveTabId(tabOrder[0]);
    return;
  }
  const nextIdx = (idx + direction + tabOrder.length) % tabOrder.length;
  setActiveTabId(tabOrder[nextIdx]);
}

/**
 * Bump a tab's unseen-completions counter when its in-flight turn
 * finishes while the user is on a different tab. Caller (the chat
 * event listener) owns the active-tab check.
 */
export function bumpUnseenCompletion(id: TabId): void {
  const tab = tabs.get(id);
  if (!tab) return;
  tabs.set(id, { ...tab, unseenCompletions: tab.unseenCompletions + 1 });
  emit();
}

/**
 * Auto-relabel a tab from the first user turn — called once per tab,
 * right after the first send. Kept idempotent: if the tab already has
 * a non-default label, this is a no-op.
 */
export function autoLabelTabFromFirstTurn(id: TabId, firstTurnText: string): void {
  const tab = tabs.get(id);
  if (!tab) return;
  if (tab.label && tab.label !== "new session") return;
  const slug = firstTurnText
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 40);
  if (!slug) return;
  tabs.set(id, { ...tab, label: slug });
  emit();
}

// ── Backward-compat helpers (existing call sites) ──────────────────

export function getActiveChat(): ChatSession | null {
  if (!activeTabId) return null;
  return tabs.get(activeTabId)?.session ?? null;
}

export function setActiveChat(s: ChatSession | null): void {
  if (!activeTabId) return;
  setTabSession(activeTabId, s);
}

export function subscribeChat(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Tear down event listeners + remove the active tab. */
export function disposeActiveChat(): void {
  if (!activeTabId) return;
  closeTab(activeTabId);
}

// ── Persistence (localStorage) ─────────────────────────────────────

type PersistedTab = {
  tabId: TabId;
  label: string;
  cwd: string;
  resumeHint?: ChatTab["resumeHint"];
};

type PersistedTabs = {
  tabs: PersistedTab[];
  activeTabId: TabId | null;
};

function persistTabs(): void {
  if (typeof window === "undefined") return;
  try {
    const persisted: PersistedTab[] = [];
    for (const id of tabOrder) {
      const t = tabs.get(id);
      if (!t) continue;
      const hint = t.session?.meta.sessionId
        ? {
            sessionId: t.session.meta.sessionId,
            transcriptMdRel: t.session.meta.transcriptMdRel ?? "",
          }
        : t.resumeHint;
      const entry: PersistedTab = {
        tabId: t.tabId,
        label: t.label,
        cwd: t.cwd,
      };
      if (hint) entry.resumeHint = hint;
      persisted.push(entry);
    }
    const payload: PersistedTabs = { tabs: persisted, activeTabId };
    window.localStorage.setItem(TAB_PERSIST_KEY, JSON.stringify(payload));
  } catch {
    // private mode / quota exceeded — drop silently
  }
}

/**
 * Restore the tab list from localStorage. Each persisted tab becomes
 * a ghost (no live session). Caller is responsible for opening one
 * on first activation. Returns the number of tabs restored.
 *
 * No-op if tabs already exist (avoids double-restore from a hot
 * remount).
 */
export function rehydrateTabs(): number {
  if (typeof window === "undefined") return 0;
  if (tabs.size > 0) return 0;
  let payload: PersistedTabs | null = null;
  try {
    const raw = window.localStorage.getItem(TAB_PERSIST_KEY);
    if (!raw) return 0;
    payload = JSON.parse(raw) as PersistedTabs;
  } catch {
    return 0;
  }
  if (!payload || !Array.isArray(payload.tabs)) return 0;
  // Rehydrate without re-persisting on every step.
  persistEnabled = false;
  for (const t of payload.tabs) {
    if (!t.tabId) continue;
    const tab: ChatTab = {
      tabId: t.tabId,
      label: t.label || "session",
      cwd: t.cwd || "",
      session: null,
      resumeHint: t.resumeHint,
      draft: "",
      attachments: [],
      unseenCompletions: 0,
    };
    tabs.set(tab.tabId, tab);
    tabOrder.push(tab.tabId);
  }
  activeTabId =
    payload.activeTabId && tabs.has(payload.activeTabId)
      ? payload.activeTabId
      : (tabOrder[0] ?? null);
  persistEnabled = true;
  emit();
  return tabOrder.length;
}

/**
 * Test/teardown helper: drops every tab and clears persistence.
 * Used by unit tests; also useful when debugging from the devtools
 * console.
 */
export function _resetTabs(): void {
  for (const tab of tabs.values()) {
    if (tab.session) {
      safeUnlisten(tab.session.dataUnlisten);
      safeUnlisten(tab.session.exitUnlisten);
      safeUnlisten(tab.session.stderrUnlisten);
    }
  }
  tabs.clear();
  tabOrder = [];
  cachedTabIds = [];
  activeTabId = null;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(TAB_PERSIST_KEY);
    } catch {
      // ignore
    }
  }
  emit();
}

function safeUnlisten(fn: UnlistenFn): void {
  try {
    fn();
  } catch {
    // ignore
  }
}

// ── Reducer (pure over a single ChatSession) ───────────────────────

/**
 * Apply a single incoming Tauri event to the active session. Pure
 * over the session shape so it's testable in isolation.
 *
 * The event wire format is whatever Claude Code emits (we forward
 * untouched), so we discriminate by the `type` + `subtype` fields
 * rather than a rigid type. This is deliberate: claude evolves the
 * schema; we degrade to "raw" handling rather than crashing if a
 * new event shape lands.
 */
export function applyEvent(s: ChatSession, event: unknown): ChatSession {
  if (!event || typeof event !== "object") return s;
  const ev = event as Record<string, unknown>;
  const type = typeof ev.type === "string" ? ev.type : "";

  if (type === "system" && ev.subtype === "init") {
    return {
      ...s,
      meta: {
        ...s.meta,
        sessionId: stringField(ev, "session_id"),
        model: stringField(ev, "model"),
        permissionMode:
          stringField(ev, "permissionMode") ??
          stringField(ev, "permission_mode"),
        mcpServers: parseMcpServers(ev.mcp_servers),
      },
    };
  }

  if (type === "user") {
    // The "user" event echoes the message we sent — but it can also
    // carry tool_result content for tool calls we made on behalf of
    // claude (PRD-116 §4.3.2 inline approval flow). We discriminate
    // by content shape.
    const content = (ev.message as Record<string, unknown> | undefined)
      ?.content;
    const toolResults = collectToolResults(content);
    if (toolResults.length > 0) {
      // Attach each result to the matching tool_use anywhere in the
      // last assistant message. (Claude streams tool_use first, then
      // a separate user event with the corresponding tool_result.)
      let next = s;
      for (const tr of toolResults) {
        next = attachToolResult(next, tr.toolUseId, tr.text, tr.isError);
      }
      return next;
    }
    // Echo of our own user turn — we already added an item locally
    // when we called chat_send, so this is a no-op. We'd need to
    // dedupe on session_id + content if claude ever started emitting
    // user echoes that aren't already in our items.
    return s;
  }

  if (type === "assistant") {
    const message = ev.message as Record<string, unknown> | undefined;
    const content = message?.content;
    const blocks = parseAssistantContent(content);
    const ts = Date.now();
    const next = appendOrUpdateAssistant(s, blocks, ts);
    // Subagent messages carry parent_tool_use_id and run in their own
    // context window, so only main-thread calls size the context chip.
    if (ev.parent_tool_use_id) return next;
    const contextTokens = promptTokens(message?.usage);
    if (contextTokens == null) return next;
    return {
      ...next,
      meta: {
        ...next.meta,
        contextTokens,
        contextPercent: computeContextPercent(
          contextTokens,
          next.meta.contextWindow,
        ),
      },
    };
  }

  if (type === "result") {
    const cost = numberField(ev, "total_cost_usd");
    const modelCosts = parseModelUsage(ev.modelUsage) ?? s.meta.modelCosts;
    const contextWindow =
      contextWindowFor(modelCosts, s.meta.model) ?? s.meta.contextWindow;
    return {
      ...s,
      inFlight: false,
      meta: {
        ...s.meta,
        totalCostUsd: cost ?? s.meta.totalCostUsd,
        modelCosts,
        contextWindow,
        contextPercent: computeContextPercent(
          s.meta.contextTokens,
          contextWindow,
        ),
      },
    };
  }

  if (type === "raw") {
    // Non-JSON line — surface as a system info item so the user
    // sees claude's launch banner / diagnostic.
    const line = stringField(ev, "line");
    if (line && line.trim()) {
      return {
        ...s,
        items: [
          ...s.items,
          {
            id: makeId(),
            kind: "system",
            level: "info",
            message: line,
            ts: Date.now(),
          },
        ],
      };
    }
    return s;
  }

  return s;
}

/** Apply a stderr line — surface as a system-level error banner. */
export function applyStderr(s: ChatSession, line: string): ChatSession {
  if (!line.trim()) return s;
  return {
    ...s,
    stderr: line,
    items: [
      ...s.items,
      {
        id: makeId(),
        kind: "system",
        level: "error",
        message: line,
        ts: Date.now(),
      },
    ],
  };
}

/** Mark the session exited. */
export function applyExit(s: ChatSession, reason?: string): ChatSession {
  return { ...s, exited: true, exitReason: reason, inFlight: false };
}

/**
 * Add a user-turn item to the session. Called optimistically when
 * the user hits Enter — we don't wait for claude's echo because we
 * want the message visible immediately.
 */
export function addUserTurn(s: ChatSession, text: string): ChatSession {
  return {
    ...s,
    items: [
      ...s.items,
      { id: makeId(), kind: "user", text, ts: Date.now() },
    ],
    inFlight: true,
  };
}

/** Append a queued message — fires after the current turn finishes. */
export function enqueueTurn(s: ChatSession, text: string): ChatSession {
  return { ...s, queue: [...s.queue, text] };
}

/** Pop the head of the queue (called by the transport when ready). */
export function dequeueTurn(s: ChatSession): {
  next: ChatSession;
  text: string | null;
} {
  if (s.queue.length === 0) return { next: s, text: null };
  const [head, ...rest] = s.queue;
  return { next: { ...s, queue: rest }, text: head };
}

/**
 * Rebuild a conversation feed from a transcript's raw event log — the
 * `.jsonl` read back via the `chat_replay` IPC. This is the visible
 * half of resume: `--resume <sessionId>` restores claude's server-side
 * context, `replayItems` restores what the user *sees* so a reopened
 * ("ghost") tab shows its prior conversation instead of an empty pane.
 * PRD-116 §4.5.
 *
 * We fold each event through the exact reducers used live, so the
 * reconstruction is faithful:
 *   - The `inFlight` lifecycle is reproduced (a user turn flips it on,
 *     the turn's `result` event flips it off), which is what makes the
 *     stream of per-block `assistant` events merge back into a single
 *     bubble per turn — and tool results re-attach to their calls.
 *   - Local user turns are re-materialized as user items. The live
 *     reducer treats a `user` event with string content as a no-op
 *     echo (the live path adds user turns optimistically in `submit`),
 *     but on replay there is no optimistic path, so we add them here.
 *
 * Unparseable / metadata-only events (`system.init`, hook events,
 * `rate_limit_event`) pass through `applyEvent` and are handled or
 * ignored exactly as they are live.
 */
export function replayItems(events: unknown[]): ChatItem[] {
  let s: ChatSession = {
    meta: { handle: "", binary_path: "", cwd: "", argv: [] },
    items: [],
    inFlight: false,
    queue: [],
    exited: false,
    dataUnlisten: () => undefined,
    exitUnlisten: () => undefined,
    stderrUnlisten: () => undefined,
  };
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const ev = event as Record<string, unknown>;
    if (ev.type === "user") {
      const message = ev.message as Record<string, unknown> | undefined;
      const content = message?.content;
      // Our own user turns are logged with a string `content` (plus an
      // `_origin: "local"` marker). Claude's `user` events instead
      // carry a tool_result array — those fall through to applyEvent so
      // the result attaches to the originating tool call.
      if (typeof content === "string") {
        s = addUserTurn(s, content);
        continue;
      }
    }
    s = applyEvent(s, event);
  }
  return s.items;
}

// ── Helpers ─────────────────────────────────────────────────────────

let idCounter = 0;
function makeId(): string {
  idCounter = (idCounter + 1) & 0xffffffff;
  return `i-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

let tabIdCounter = 0;
function makeTabId(): TabId {
  tabIdCounter = (tabIdCounter + 1) & 0xffffffff;
  return `t-${Date.now().toString(36)}-${tabIdCounter.toString(36)}`;
}

function stringField(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

function numberField(
  obj: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = obj[key];
  return typeof v === "number" ? v : undefined;
}

function parseMcpServers(
  v: unknown,
): { name: string; status?: string }[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: { name: string; status?: string }[] = [];
  for (const entry of v) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name : null;
    if (!name) continue;
    const status = typeof r.status === "string" ? r.status : undefined;
    out.push(status === undefined ? { name } : { name, status });
  }
  return out;
}

/**
 * Parse the `content` field of an assistant message. Claude Code's
 * shape is a list of blocks: text, tool_use, thinking. We map each
 * to our internal AssistantBlock variant.
 */
function parseAssistantContent(content: unknown): AssistantBlock[] {
  if (typeof content === "string") {
    // Older / simpler shape — plain string content.
    return content ? [{ kind: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: AssistantBlock[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as Record<string, unknown>;
    const t = block.type;
    if (t === "text") {
      const text = typeof block.text === "string" ? block.text : "";
      if (text) blocks.push({ kind: "text", text });
    } else if (t === "thinking") {
      const text = typeof block.thinking === "string" ? block.thinking : "";
      if (text) blocks.push({ kind: "thinking", text });
    } else if (t === "tool_use") {
      const id = typeof block.id === "string" ? block.id : "";
      const name = typeof block.name === "string" ? block.name : "tool";
      const input = block.input ?? {};
      if (id) {
        blocks.push({
          kind: "tool_use",
          call: { id, name, input, result: null, isError: false },
        });
      }
    }
  }
  return blocks;
}

/**
 * Append a new assistant item, OR merge the new blocks into the
 * most-recent assistant item if it's still in-flight. This is what
 * gives us the "streamed text appears incrementally" feel — claude
 * emits multiple `assistant` events per turn as it produces output.
 */
function appendOrUpdateAssistant(
  s: ChatSession,
  newBlocks: AssistantBlock[],
  ts: number,
): ChatSession {
  if (newBlocks.length === 0) return s;
  const last = s.items[s.items.length - 1];
  if (last && last.kind === "assistant" && s.inFlight) {
    const merged = mergeAssistantBlocks(last.blocks, newBlocks);
    const items = s.items.slice(0, -1);
    items.push({ ...last, blocks: merged });
    return { ...s, items };
  }
  return {
    ...s,
    items: [
      ...s.items,
      {
        id: makeId(),
        kind: "assistant",
        blocks: newBlocks,
        ts,
      },
    ],
  };
}

/**
 * Merge a new chunk of assistant blocks into an existing list.
 * Concatenates trailing text blocks (claude streams text in pieces),
 * appends new tool_use blocks as separate entries, and replaces
 * thinking blocks (we only show the final reasoning).
 */
function mergeAssistantBlocks(
  prev: AssistantBlock[],
  next: AssistantBlock[],
): AssistantBlock[] {
  const merged: AssistantBlock[] = [...prev];
  for (const block of next) {
    const last = merged[merged.length - 1];
    if (block.kind === "text" && last?.kind === "text") {
      merged[merged.length - 1] = { kind: "text", text: last.text + block.text };
    } else if (block.kind === "thinking" && last?.kind === "thinking") {
      // Replace, not concat — thinking is summarized at the end.
      merged[merged.length - 1] = block;
    } else {
      merged.push(block);
    }
  }
  return merged;
}

function collectToolResults(
  content: unknown,
): { toolUseId: string; text: string; isError: boolean }[] {
  if (!Array.isArray(content)) return [];
  const results: { toolUseId: string; text: string; isError: boolean }[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (r.type !== "tool_result") continue;
    const id = typeof r.tool_use_id === "string" ? r.tool_use_id : "";
    if (!id) continue;
    const isError = r.is_error === true;
    const text = stringifyToolContent(r.content);
    results.push({ toolUseId: id, text, isError });
  }
  return results;
}

function stringifyToolContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? "");
  // Block-list shape: { type: 'text', text: '...' } entries.
  const parts: string[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (r.type === "text" && typeof r.text === "string") parts.push(r.text);
    else parts.push(JSON.stringify(r));
  }
  return parts.join("\n");
}

/**
 * Walk every assistant item in reverse and find the matching
 * tool_use; mutate that block's call.result. Returns a new session
 * with one item replaced.
 */
function attachToolResult(
  s: ChatSession,
  toolUseId: string,
  text: string,
  isError: boolean,
): ChatSession {
  for (let i = s.items.length - 1; i >= 0; i--) {
    const item = s.items[i];
    if (item.kind !== "assistant") continue;
    let foundBlockIdx = -1;
    for (let b = 0; b < item.blocks.length; b++) {
      const blk = item.blocks[b];
      if (blk.kind === "tool_use" && blk.call.id === toolUseId) {
        foundBlockIdx = b;
        break;
      }
    }
    if (foundBlockIdx >= 0) {
      const target = item.blocks[foundBlockIdx];
      if (target.kind !== "tool_use") return s;
      const updatedCall: ToolCall = {
        ...target.call,
        result: text,
        isError,
      };
      const blocks = [...item.blocks];
      blocks[foundBlockIdx] = { kind: "tool_use", call: updatedCall };
      const items = [...s.items];
      items[i] = { ...item, blocks };
      return { ...s, items };
    }
  }
  return s;
}

/** Rounded share of the context window in use. Undefined until both
 *  the prompt size and the window are known. */
function computeContextPercent(
  tokens: number | undefined,
  window: number | undefined,
): number | undefined {
  if (tokens == null || !window) return undefined;
  return Math.min(100, Math.round((tokens / window) * 100));
}

/** Prompt size of one API call. `input_tokens` alone is only the
 *  uncached tail (often single digits); the cached prefix is in the
 *  cache read/write counts. */
function promptTokens(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  const total =
    (numberField(u, "input_tokens") ?? 0) +
    (numberField(u, "cache_read_input_tokens") ?? 0) +
    (numberField(u, "cache_creation_input_tokens") ?? 0);
  return total > 0 ? total : undefined;
}

function parseModelUsage(raw: unknown): ModelCost[] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const rows: ModelCost[] = [];
  for (const [model, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const u = v as Record<string, unknown>;
    rows.push({
      model,
      canonicalModel: stringField(u, "canonicalModel"),
      costUsd: numberField(u, "costUSD") ?? 0,
      costBasis: stringField(u, "costBasis"),
      contextWindow: numberField(u, "contextWindow"),
    });
  }
  if (rows.length === 0) return undefined;
  return rows.sort((a, b) => b.costUsd - a.costUsd);
}

/** The session model's context window. Matches on the modelUsage key or
 *  Claude Code's canonical id; a single-model session needs no match. */
function contextWindowFor(
  rows: ModelCost[] | undefined,
  model: string | undefined,
): number | undefined {
  if (!rows || rows.length === 0) return undefined;
  const hit = model
    ? rows.find((r) => r.model === model || r.canonicalModel === model)
    : undefined;
  return (hit ?? (rows.length === 1 ? rows[0] : undefined))?.contextWindow;
}

const COST_BASIS_LABELS: Record<string, string> = {
  list: "list price",
  managed: "org pricing",
  unknown: "guessed: no rate for this model",
};

/**
 * Tooltip + warning flag for the cost chip. Claude Code tags each
 * model with the rates it priced it at; "unknown" means it had no rate
 * for that model, so the total is partly a guess.
 */
export function describeSessionCost(modelCosts: ModelCost[] | undefined): {
  title: string;
  isGuess: boolean;
} {
  const rows = modelCosts ?? [];
  const bases = new Set(rows.map((r) => r.costBasis));
  const isGuess = bases.has("unknown");
  const basis = isGuess
    ? "estimate"
    : bases.has("managed")
      ? bases.has("list")
        ? "list + org pricing"
        : "org pricing"
      : "list price";
  const lines = rows.map((r) => {
    const label = r.costBasis
      ? ` · ${COST_BASIS_LABELS[r.costBasis] ?? r.costBasis}`
      : "";
    return `${r.model}: $${r.costUsd.toFixed(4)}${label}`;
  });
  return { title: [`Session cost (${basis})`, ...lines].join("\n"), isGuess };
}
