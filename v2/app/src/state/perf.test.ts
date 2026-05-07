import { beforeEach, describe, expect, it, vi } from "vitest";

import { mark, time } from "./perf";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => invokeMock(cmd, args),
}));

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
});

describe("perf.mark", () => {
  it("records via perf_record on done()", async () => {
    const done = mark("view-switch", { from: "home", to: "work" });
    // Tick the perf clock by advancing time. We can't easily mock
    // performance.now() across vitest; rely on a short await.
    await new Promise((r) => setTimeout(r, 5));
    done();
    // recordSample is fire-and-forget — wait a microtask.
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = invokeMock.mock.calls[0];
    expect(cmd).toBe("perf_record");
    const sample = (args as { sample: Record<string, unknown> }).sample;
    expect(sample.kind).toBe("view-switch");
    expect(typeof sample.duration_ms).toBe("number");
    expect(sample.duration_ms).toBeGreaterThan(0);
    expect(typeof sample.at).toBe("string");
    expect(sample.meta).toEqual({ from: "home", to: "work" });
  });

  it("done() is idempotent — second call doesn't re-record", async () => {
    const done = mark("palette-open");
    done();
    done();
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("swallows IPC errors silently", async () => {
    invokeMock.mockRejectedValueOnce(new Error("backend down"));
    const done = mark("ipc");
    expect(() => done()).not.toThrow();
  });
});

describe("perf.time", () => {
  it("records duration even when the inner promise rejects", async () => {
    const err = new Error("kaboom");
    await expect(
      time("ipc", async () => {
        throw err;
      }),
    ).rejects.toBe(err);
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const sample = (invokeMock.mock.calls[0][1] as { sample: { kind: string } }).sample;
    expect(sample.kind).toBe("ipc");
  });

  it("returns the inner result on success", async () => {
    const result = await time("ipc", async () => 42);
    expect(result).toBe(42);
  });
});
