import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTaskFromText } from "./createTask";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => invokeMock(cmd, args),
}));

beforeEach(() => {
  invokeMock.mockReset();
});

describe("createTaskFromText", () => {
  it("rejects empty input without invoking IPC", async () => {
    const result = await createTaskFromText("   ", true);
    expect(result.task).toBeNull();
    expect(result.error).toMatch(/empty/);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("creates with raw title when parseWithClaude is false", async () => {
    invokeMock.mockResolvedValueOnce({ id: "t1", title: "buy milk" });
    const result = await createTaskFromText("  buy milk  ", false);
    expect(result.task).toEqual({ id: "t1", title: "buy milk" });
    expect(result.error).toBeNull();
    expect(result.parseFailed).toBe(false);
    // claude_parse_task should NOT be called when parseWithClaude=false
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0][0]).toBe("v1_tasks_create");
    expect(invokeMock.mock.calls[0][1]).toEqual({
      input: { title: "buy milk" },
    });
  });

  it("uses parsed fields when claude_parse_task succeeds", async () => {
    invokeMock
      .mockResolvedValueOnce({
        title: "Call Bob",
        priority: "high",
        due: "2026-04-25",
        project: "leadership",
        tags: ["work"],
        notes: null,
      })
      .mockResolvedValueOnce({ id: "t2", title: "Call Bob" });
    const result = await createTaskFromText(
      "call bob tomorrow asap",
      true,
    );
    expect(result.task?.id).toBe("t2");
    expect(result.parseFailed).toBe(false);
    expect(invokeMock.mock.calls[0][0]).toBe("claude_parse_task");
    expect(invokeMock.mock.calls[1][0]).toBe("v1_tasks_create");
    expect(invokeMock.mock.calls[1][1]).toEqual({
      input: {
        title: "Call Bob",
        priority: "high",
        due: "2026-04-25",
        project: "leadership",
        tags: ["work"],
        notes: null,
      },
    });
  });

  it("falls back to raw title when claude_parse_task throws", async () => {
    invokeMock
      .mockRejectedValueOnce(new Error("claude unreachable"))
      .mockResolvedValueOnce({ id: "t3", title: "follow up" });
    const result = await createTaskFromText("follow up", true);
    expect(result.task?.id).toBe("t3");
    expect(result.parseFailed).toBe(true);
    expect(result.error).toBeNull();
    expect(invokeMock.mock.calls[1][1]).toEqual({
      input: { title: "follow up" },
    });
  });

  it("surfaces v1_tasks_create errors", async () => {
    invokeMock.mockRejectedValueOnce(new Error("db locked"));
    const result = await createTaskFromText("x", false);
    expect(result.task).toBeNull();
    expect(result.error).toMatch(/db locked/);
  });

  it("preserves trimmed title when claude_parse_task returns empty title", async () => {
    invokeMock
      .mockResolvedValueOnce({
        title: "",
        priority: "medium",
        due: null,
        project: null,
        tags: [],
        notes: null,
      })
      .mockResolvedValueOnce({ id: "t4", title: "weird input" });
    const result = await createTaskFromText("  weird input  ", true);
    expect(result.task?.id).toBe("t4");
    // Empty parsed.title shouldn't blank out the input — fall back to
    // the trimmed user text.
    expect(invokeMock.mock.calls[1][1]).toEqual({
      input: {
        title: "weird input",
        priority: "medium",
        due: null,
        project: null,
        tags: [],
        notes: null,
      },
    });
  });
});
