import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  newSessionForOwner,
  todayLocalIsoDate,
} from "./newSession";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => invokeMock(cmd, args),
}));

beforeEach(() => {
  invokeMock.mockReset();
});

describe("todayLocalIsoDate", () => {
  it("returns YYYY-MM-DD shape", () => {
    const d = todayLocalIsoDate();
    expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("newSessionForOwner", () => {
  it("invokes content_create_session with the right args", async () => {
    invokeMock.mockResolvedValueOnce("areas/x/y/sessions/2026-04-25.md");
    const result = await newSessionForOwner(
      "areas/one-on-ones/peers/peer-a",
      "Peer A",
      "2026-04-25",
    );
    expect(result.relPath).toBe("areas/x/y/sessions/2026-04-25.md");
    expect(result.error).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith("content_create_session", {
      ownerRelPath: "areas/one-on-ones/peers/peer-a",
      date: "2026-04-25",
      ownerLabel: "Peer A",
    });
  });

  it("defaults date to today (local) when omitted", async () => {
    invokeMock.mockResolvedValueOnce("areas/x/y/sessions/whatever.md");
    await newSessionForOwner("areas/x/y", "Whatever");
    const passed = invokeMock.mock.calls[0][1] as { date: string };
    expect(passed.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns the error string when IPC throws", async () => {
    invokeMock.mockRejectedValueOnce(new Error("session already exists"));
    const result = await newSessionForOwner("a", "A", "2026-04-25");
    expect(result.relPath).toBeNull();
    expect(result.error).toMatch(/already exists/);
  });
});
