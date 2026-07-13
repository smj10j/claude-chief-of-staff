/**
 * PRD-116 Console — top-level surface.
 *
 * Hosts the mode toggle (`Chat | Raw`), the Phase 3 tab strip (chat
 * mode only — raw mode is a single-shell PTY), and the active tab's
 * renderer.
 *
 * Mode is sticky per-workspace (localStorage). Tabs are likewise
 * persisted to localStorage by the chatSession module so a restart
 * can rehydrate the strip with ghost tabs that reopen via `--resume`
 * on first activation.
 *
 * Mode-toggle bridging via `--resume <session-id>` (raw ↔ chat with
 * preserved conversation) is deferred — the Rust transport already
 * accepts a resume id, so it's purely a frontend wiring follow-up.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MessageSquare, Plus, Terminal as TerminalIcon, X } from "lucide-react";

import { ChatView } from "./console/ChatView";
import { RawConsole } from "./console/RawConsole";
import {
  closeTab,
  createTab,
  cycleTab,
  getActiveTabId,
  getTab,
  getTabIds,
  getVersion,
  rehydrateTabs,
  setActiveTabId,
  subscribeChat,
  type TabId,
} from "../state/chatSession";

type Mode = "chat" | "raw";

const MODE_KEY = "cos.console.mode.v1";

function readMode(): Mode {
  if (typeof window === "undefined") return "chat";
  try {
    const v = window.localStorage.getItem(MODE_KEY);
    return v === "raw" ? "raw" : "chat";
  } catch {
    return "chat";
  }
}

function writeMode(m: Mode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MODE_KEY, m);
  } catch {
    // private mode — session-only
  }
}

export function Console({ active = true }: { active?: boolean }) {
  const [mode, setMode] = useState<Mode>(() => readMode());

  useEffect(() => {
    writeMode(mode);
  }, [mode]);

  // One-shot rehydration from persistence on first mount. If no tabs
  // have been opened yet (fresh app), this is a no-op and the chat
  // surface starts in its own empty state.
  useEffect(() => {
    rehydrateTabs();
  }, []);

  return (
    <div className="cos-console-shell">
      <div className="cos-console-mode-bar">
        <div className="cos-console-mode-bar-title">
          <TerminalIcon size={14} strokeWidth={1.75} aria-hidden />
          <span>Console</span>
        </div>
        <div
          className="cos-console-mode-toggle"
          role="tablist"
          aria-label="Console mode"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === "chat"}
            className={`cos-console-mode-option${
              mode === "chat" ? " is-active" : ""
            }`}
            onClick={() => setMode("chat")}
            title="Structured chat with tool cards + diffs"
          >
            <MessageSquare size={12} strokeWidth={1.75} aria-hidden />
            chat
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "raw"}
            className={`cos-console-mode-option${
              mode === "raw" ? " is-active" : ""
            }`}
            onClick={() => setMode("raw")}
            title="Real PTY-backed terminal"
          >
            <TerminalIcon size={12} strokeWidth={1.75} aria-hidden />
            raw
          </button>
        </div>
      </div>
      <div className="cos-console-mode-body">
        {mode === "chat" ? <ChatHost active={active} /> : <RawConsole />}
      </div>
    </div>
  );
}

/**
 * Phase 3 tab host. Owns the tab strip + renders ChatView for the
 * active tab. Keyed on `tabId` so React mounts a fresh ChatView per
 * tab — that's how each tab gets independent local UI state (find
 * bar open/closed, history index, etc.). Per-tab draft and
 * attachments survive because they're stored on the tab record.
 */
function ChatHost({ active }: { active: boolean }) {
  // Bump the host on any store mutation so children re-read fresh
  // tab data (label, in-flight, unseen pip). `getVersion` is a
  // primitive so it's stable under Object.is comparison.
  useSyncExternalStore(subscribeChat, getVersion, getVersion);
  const tabIds = getTabIds();
  const activeTabId = getActiveTabId();

  // Make sure we always have at least one tab so the input box and
  // empty state have somewhere to live. If rehydration brought tabs
  // back, we're fine; otherwise create a starter tab on first render.
  useEffect(() => {
    if (tabIds.length === 0) createTab();
    // intentionally only on mount + when tabs go to zero
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabIds.length]);

  // Keyboard: Cmd+T new, Cmd+W close, Cmd+Opt+Arrow cycle. Only while
  // the Console surface is actually visible — it stays mounted (hidden)
  // when you switch away, so an ungated window listener would hijack
  // ⌘T/⌘W on every other surface.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      // ⌘T / ⌘W (no Shift) manage console tabs. The global handler
      // (Shell) yields these to us while the Console surface is active,
      // so exactly one action fires. Shifted variants stay reserved for
      // the workspace (⌘⇧T reopen, ⌘⇧[ / ⌘⇧] cycle).
      if ((e.key === "t" || e.key === "T") && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        const id = createTab();
        setActiveTabId(id);
        return;
      }
      if ((e.key === "w" || e.key === "W") && !e.shiftKey) {
        if (activeTabId) {
          e.preventDefault();
          handleClose(activeTabId);
        }
        return;
      }
      if (e.altKey && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
        e.preventDefault();
        cycleTab(e.key === "ArrowRight" ? 1 : -1);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, active]);

  const handleClose = useCallback(async (id: TabId) => {
    const tab = getTab(id);
    if (!tab) return;
    if (tab.session && tab.session.inFlight && !tab.session.exited) {
      const ok = window.confirm(
        "Close this tab? Claude is mid-turn — the in-flight response will be lost.",
      );
      if (!ok) return;
    }
    if (tab.session) {
      try {
        await invoke("chat_close", { handle: tab.session.meta.handle });
      } catch {
        // best-effort
      }
    }
    closeTab(id);
  }, []);

  return (
    <div className="cos-chat-host">
      <TabStrip
        tabIds={tabIds}
        activeTabId={activeTabId}
        onSelect={(id) => setActiveTabId(id)}
        onClose={(id) => void handleClose(id)}
        onNew={() => {
          const id = createTab();
          setActiveTabId(id);
        }}
      />
      {activeTabId ? (
        <ChatView
          key={activeTabId}
          tabId={activeTabId}
          model=""
          permissionMode="auto"
        />
      ) : null}
    </div>
  );
}

function TabStrip({
  tabIds,
  activeTabId,
  onSelect,
  onClose,
  onNew,
}: {
  tabIds: TabId[];
  activeTabId: TabId | null;
  onSelect: (id: TabId) => void;
  onClose: (id: TabId) => void;
  onNew: () => void;
}) {
  return (
    <div className="cos-chat-tabstrip" role="tablist" aria-label="Console tabs">
      {tabIds.map((id) => (
        <TabButton
          key={id}
          tabId={id}
          isActive={id === activeTabId}
          onSelect={() => onSelect(id)}
          onClose={() => onClose(id)}
          canClose={tabIds.length > 1}
        />
      ))}
      <button
        type="button"
        className="cos-chat-tabstrip-new"
        onClick={onNew}
        title="New tab (⌘T)"
        aria-label="New tab"
      >
        <Plus size={12} strokeWidth={2} aria-hidden />
      </button>
    </div>
  );
}

function TabButton({
  tabId,
  isActive,
  onSelect,
  onClose,
  canClose,
}: {
  tabId: TabId;
  isActive: boolean;
  onSelect: () => void;
  onClose: () => void;
  canClose: boolean;
}) {
  const tab = getTab(tabId);
  if (!tab) return null;
  const inFlight = tab.session?.inFlight ?? false;
  const exited = tab.session?.exited ?? false;
  const unseen = tab.unseenCompletions;
  return (
    <div
      role="tab"
      aria-selected={isActive}
      className={`cos-chat-tab${isActive ? " is-active" : ""}${
        exited ? " is-exited" : ""
      }`}
      onClick={onSelect}
    >
      {inFlight && <span className="cos-spin cos-chat-tab-spin" aria-hidden />}
      <span className="cos-chat-tab-label" title={tab.label}>
        {tab.label || "session"}
      </span>
      {unseen > 0 && !isActive && (
        <span className="cos-chat-tab-pip" title={`${unseen} done`}>
          {unseen}
        </span>
      )}
      {canClose && (
        <button
          type="button"
          className="cos-chat-tab-close"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          title="Close tab (⌘W)"
          aria-label={`Close ${tab.label}`}
        >
          <X size={10} strokeWidth={2} aria-hidden />
        </button>
      )}
    </div>
  );
}
