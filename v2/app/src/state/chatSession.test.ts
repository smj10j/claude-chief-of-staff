import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetTabs,
  addUserTurn,
  applyEvent,
  applyExit,
  applyStderr,
  autoLabelTabFromFirstTurn,
  bumpUnseenCompletion,
  closeTab,
  createTab,
  cycleTab,
  dequeueTurn,
  enqueueTurn,
  getActiveTabId,
  getInFlightCount,
  getTab,
  getTabIds,
  getUnseenCount,
  rehydrateTabs,
  setActiveTabId,
  setTabSession,
  updateTab,
  type ChatSession,
} from "./chatSession";

const NOOP = () => undefined;

function freshSession(): ChatSession {
  return {
    meta: {
      handle: "chat-1",
      binary_path: "/bin/claude",
      cwd: "/tmp",
      argv: [],
    },
    items: [],
    inFlight: false,
    queue: [],
    exited: false,
    dataUnlisten: NOOP,
    exitUnlisten: NOOP,
    stderrUnlisten: NOOP,
  };
}

describe("chatSession reducer", () => {
  it("captures session id + model from system.init", () => {
    const s0 = freshSession();
    const s1 = applyEvent(s0, {
      type: "system",
      subtype: "init",
      session_id: "abc-123",
      model: "claude-opus-4-7",
      permissionMode: "acceptEdits",
      cwd: "/tmp",
      mcp_servers: [{ name: "datadog-mcp", status: "connected" }],
    });
    expect(s1.meta.sessionId).toBe("abc-123");
    expect(s1.meta.model).toBe("claude-opus-4-7");
    expect(s1.meta.permissionMode).toBe("acceptEdits");
    expect(s1.meta.mcpServers).toEqual([
      { name: "datadog-mcp", status: "connected" },
    ]);
  });

  it("falls back to permission_mode when permissionMode is missing", () => {
    const s = applyEvent(freshSession(), {
      type: "system",
      subtype: "init",
      session_id: "x",
      permission_mode: "plan",
    });
    expect(s.meta.permissionMode).toBe("plan");
  });

  it("appends an assistant item from a string-content message", () => {
    const s = applyEvent(addUserTurn(freshSession(), "hi"), {
      type: "assistant",
      message: { role: "assistant", content: "hello there" },
    });
    expect(s.items).toHaveLength(2);
    const last = s.items[1];
    expect(last.kind).toBe("assistant");
    if (last.kind !== "assistant") return;
    expect(last.blocks).toEqual([{ kind: "text", text: "hello there" }]);
  });

  it("merges streamed text into the in-flight assistant item", () => {
    let s = addUserTurn(freshSession(), "hi");
    s = applyEvent(s, {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "hel" }] },
    });
    s = applyEvent(s, {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "lo" }] },
    });
    expect(s.items).toHaveLength(2);
    const last = s.items[1];
    expect(last.kind).toBe("assistant");
    if (last.kind !== "assistant") return;
    expect(last.blocks).toEqual([{ kind: "text", text: "hello" }]);
  });

  it("treats tool_use blocks as separate assistant blocks", () => {
    let s = addUserTurn(freshSession(), "hi");
    s = applyEvent(s, {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "let me check" },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Read",
            input: { file_path: "x" },
          },
        ],
      },
    });
    const last = s.items[1];
    if (last.kind !== "assistant") throw new Error("bad");
    expect(last.blocks).toHaveLength(2);
    expect(last.blocks[1].kind).toBe("tool_use");
  });

  it("attaches tool_result to the matching tool_use", () => {
    let s = addUserTurn(freshSession(), "hi");
    s = applyEvent(s, {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Read",
            input: { file_path: "x" },
          },
        ],
      },
    });
    s = applyEvent(s, {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "file contents here",
            is_error: false,
          },
        ],
      },
    });
    const item = s.items[s.items.length - 1];
    if (item.kind !== "assistant") throw new Error("bad");
    const block = item.blocks[0];
    if (block.kind !== "tool_use") throw new Error("bad");
    expect(block.call.result).toBe("file contents here");
    expect(block.call.isError).toBe(false);
  });

  it("marks tool_result as error when is_error is true", () => {
    let s = addUserTurn(freshSession(), "hi");
    s = applyEvent(s, {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_2",
            name: "Bash",
            input: { command: "false" },
          },
        ],
      },
    });
    s = applyEvent(s, {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_2",
            content: "exit 1",
            is_error: true,
          },
        ],
      },
    });
    const item = s.items[s.items.length - 1];
    if (item.kind !== "assistant") throw new Error("bad");
    const block = item.blocks[0];
    if (block.kind !== "tool_use") throw new Error("bad");
    expect(block.call.isError).toBe(true);
  });

  it("captures cost + tokens + context% on result event", () => {
    let s = addUserTurn(freshSession(), "hi");
    s = applyEvent(s, {
      type: "system",
      subtype: "init",
      session_id: "x",
      model: "claude-opus-4-7",
    });
    s = applyEvent(s, {
      type: "result",
      subtype: "success",
      total_cost_usd: 0.0142,
      usage: { input_tokens: 1000, output_tokens: 500 },
    });
    expect(s.meta.totalCostUsd).toBeCloseTo(0.0142);
    expect(s.meta.inputTokens).toBe(1000);
    expect(s.meta.outputTokens).toBe(500);
    // 1500/200000 = 0.75% → 1
    expect(s.meta.contextPercent).toBe(1);
    expect(s.inFlight).toBe(false);
  });

  it("flips inFlight off on result", () => {
    let s = addUserTurn(freshSession(), "hi");
    expect(s.inFlight).toBe(true);
    s = applyEvent(s, { type: "result", subtype: "success" });
    expect(s.inFlight).toBe(false);
  });

  it("queues + dequeues turns in FIFO order", () => {
    let s = freshSession();
    s = enqueueTurn(s, "first");
    s = enqueueTurn(s, "second");
    expect(s.queue).toEqual(["first", "second"]);
    const r1 = dequeueTurn(s);
    expect(r1.text).toBe("first");
    const r2 = dequeueTurn(r1.next);
    expect(r2.text).toBe("second");
    const r3 = dequeueTurn(r2.next);
    expect(r3.text).toBeNull();
  });

  it("dequeue on empty queue returns null + same session", () => {
    const s = freshSession();
    const { next, text } = dequeueTurn(s);
    expect(text).toBeNull();
    expect(next).toBe(s);
  });

  it("stderr line shows up as a system error item", () => {
    const s = applyStderr(freshSession(), "fatal: something broke");
    expect(s.stderr).toBe("fatal: something broke");
    const last = s.items[s.items.length - 1];
    expect(last.kind).toBe("system");
    if (last.kind !== "system") return;
    expect(last.level).toBe("error");
    expect(last.message).toBe("fatal: something broke");
  });

  it("empty stderr is ignored (no item, no banner)", () => {
    const s = applyStderr(freshSession(), "   ");
    expect(s.stderr).toBeUndefined();
    expect(s.items).toHaveLength(0);
  });

  it("exit event flips exited + inFlight off", () => {
    let s = addUserTurn(freshSession(), "hi");
    s = applyExit(s, "eof");
    expect(s.exited).toBe(true);
    expect(s.exitReason).toBe("eof");
    expect(s.inFlight).toBe(false);
  });

  it("raw event surfaces as a system info item", () => {
    const s = applyEvent(freshSession(), {
      type: "raw",
      line: "WARN: claude is preparing your session…",
    });
    expect(s.items).toHaveLength(1);
    const item = s.items[0];
    if (item.kind !== "system") throw new Error("bad");
    expect(item.level).toBe("info");
    expect(item.message).toMatch(/WARN/);
  });

  it("unknown event type is a no-op", () => {
    const s0 = freshSession();
    const s1 = applyEvent(s0, { type: "future_thing", payload: 42 });
    expect(s1).toEqual(s0);
  });
});

describe("chatSession tabs (Phase 3)", () => {
  beforeEach(() => _resetTabs());
  afterEach(() => _resetTabs());

  it("createTab adds a tab and makes it active when nothing else exists", () => {
    const id = createTab({ label: "first" });
    expect(getTabIds()).toEqual([id]);
    expect(getActiveTabId()).toBe(id);
    const tab = getTab(id);
    expect(tab?.label).toBe("first");
    expect(tab?.session).toBeNull();
  });

  it("createTab respects silent: does not flip active tab", () => {
    const a = createTab();
    const b = createTab({ silent: true });
    expect(getActiveTabId()).toBe(a);
    expect(getTabIds()).toEqual([a, b]);
  });

  it("closeTab picks the right neighbor when closing the active tab", () => {
    const a = createTab({ label: "a" });
    const b = createTab({ label: "b" });
    const c = createTab({ label: "c" });
    setActiveTabId(b);
    closeTab(b);
    // Closed middle → next active is the tab that took its slot (c).
    expect(getActiveTabId()).toBe(c);
    expect(getTabIds()).toEqual([a, c]);
  });

  it("closeTab leaves activeTabId null when last tab closed", () => {
    const a = createTab();
    closeTab(a);
    expect(getActiveTabId()).toBeNull();
    expect(getTabIds()).toEqual([]);
  });

  it("cycleTab wraps around", () => {
    const a = createTab();
    const b = createTab({ silent: true });
    const c = createTab({ silent: true });
    setActiveTabId(a);
    cycleTab(1);
    expect(getActiveTabId()).toBe(b);
    cycleTab(1);
    expect(getActiveTabId()).toBe(c);
    cycleTab(1);
    expect(getActiveTabId()).toBe(a);
    cycleTab(-1);
    expect(getActiveTabId()).toBe(c);
  });

  it("bumpUnseenCompletion increments and setActiveTabId clears", () => {
    const a = createTab();
    const b = createTab({ silent: true });
    setActiveTabId(a);
    bumpUnseenCompletion(b);
    bumpUnseenCompletion(b);
    expect(getTab(b)?.unseenCompletions).toBe(2);
    expect(getUnseenCount()).toBe(2);
    setActiveTabId(b);
    expect(getTab(b)?.unseenCompletions).toBe(0);
    expect(getUnseenCount()).toBe(0);
  });

  it("autoLabelTabFromFirstTurn names a default tab from first user turn", () => {
    const id = createTab(); // default label "new session"
    autoLabelTabFromFirstTurn(id, "summarize last 3 sessions with @alice");
    expect(getTab(id)?.label).toContain("summarize last 3 sessions");
  });

  it("autoLabelTabFromFirstTurn does not overwrite a custom label", () => {
    const id = createTab({ label: "my custom name" });
    autoLabelTabFromFirstTurn(id, "doesn't matter");
    expect(getTab(id)?.label).toBe("my custom name");
  });

  it("getInFlightCount sums across tabs with active runtimes", () => {
    const a = createTab();
    const b = createTab({ silent: true });
    const sa: ChatSession = {
      meta: {
        handle: "ha",
        binary_path: "/bin/claude",
        cwd: "/tmp",
        argv: [],
      },
      items: [],
      inFlight: true,
      queue: [],
      exited: false,
      dataUnlisten: NOOP,
      exitUnlisten: NOOP,
      stderrUnlisten: NOOP,
    };
    const sb: ChatSession = { ...sa, meta: { ...sa.meta, handle: "hb" }, inFlight: false };
    setTabSession(a, sa);
    setTabSession(b, sb);
    expect(getInFlightCount()).toBe(1);
  });

  it("rehydrateTabs restores ghost tabs from localStorage", () => {
    const a = createTab({ label: "first", cwd: "/tmp/foo" });
    const b = createTab({ silent: true, label: "second" });
    updateTab(b, { resumeHint: { sessionId: "sess-b", transcriptMdRel: "x.md" } });
    const before = getTabIds();
    expect(before.length).toBe(2);
    // Wipe in-memory state but keep the persisted blob.
    const persisted = window.localStorage.getItem("cos.console.tabs.v1");
    expect(persisted).not.toBeNull();
    // _resetTabs clears localStorage too — workaround: keep the
    // payload, reset, and re-stash it.
    _resetTabs();
    window.localStorage.setItem("cos.console.tabs.v1", persisted!);
    const restored = rehydrateTabs();
    expect(restored).toBe(2);
    expect(getTabIds()).toEqual([a, b]);
    expect(getTab(b)?.resumeHint?.sessionId).toBe("sess-b");
  });

  it("rehydrateTabs no-ops when tabs already exist", () => {
    createTab();
    const restored = rehydrateTabs();
    expect(restored).toBe(0);
  });
});
