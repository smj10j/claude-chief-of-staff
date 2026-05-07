/**
 * Updater state-machine tests (PRD-103 Phase 1B).
 *
 * Covers the pure logic — readAutoInstall / writeAutoInstall persistence,
 * checkForUpdate state transitions for happy-path / no-update / error /
 * urgent variants, downloadAvailableUpdate progress events, and the
 * silent-vs-loud branching that keeps the auto-check from spamming.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Module-level mocks for the dynamically-imported Tauri plugins.
// Tests inject the per-call behavior via the `checkMock` /
// `downloadMock` references the mock factory exposes.
const checkMock = vi.fn();
const relaunchMock = vi.fn();

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: checkMock,
}));
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: relaunchMock,
}));

import {
  _resetForTest,
  checkForUpdate,
  downloadAvailableUpdate,
  getUpdateState,
  readAutoInstall,
  relaunchToInstall,
  writeAutoInstall,
} from "./updater";

beforeEach(() => {
  checkMock.mockReset();
  relaunchMock.mockReset();
  window.localStorage.clear();
  _resetForTest();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("readAutoInstall / writeAutoInstall", () => {
  it("defaults to true when no flag is set", () => {
    expect(readAutoInstall()).toBe(true);
  });

  it("respects an explicit false", () => {
    writeAutoInstall(false);
    expect(readAutoInstall()).toBe(false);
  });

  it("flips back to true on writeAutoInstall(true)", () => {
    writeAutoInstall(false);
    writeAutoInstall(true);
    expect(readAutoInstall()).toBe(true);
  });
});

describe("checkForUpdate", () => {
  it("silent + no update → idle (no banner noise)", async () => {
    checkMock.mockResolvedValueOnce(null);
    const result = await checkForUpdate({ silent: true });
    expect(result.kind).toBe("idle");
    expect(getUpdateState().kind).toBe("idle");
  });

  it("loud + no update → uptodate", async () => {
    checkMock.mockResolvedValueOnce(null);
    const result = await checkForUpdate({ silent: false });
    expect(result.kind).toBe("uptodate");
  });

  it("update found → available with version + notes", async () => {
    checkMock.mockResolvedValueOnce({
      version: "0.2.0",
      body: "Bug fixes and improvements.",
      downloadAndInstall: vi.fn(),
    });
    const result = await checkForUpdate();
    expect(result.kind).toBe("available");
    if (result.kind !== "available") return;
    expect(result.version).toBe("0.2.0");
    expect(result.notes).toBe("Bug fixes and improvements.");
    expect(result.urgent).toBe(false);
  });

  it("urgent: prefix in notes flips the urgent flag", async () => {
    checkMock.mockResolvedValueOnce({
      version: "0.2.1",
      body: "URGENT: fixes a crash on launch",
      downloadAndInstall: vi.fn(),
    });
    const result = await checkForUpdate();
    expect(result.kind).toBe("available");
    if (result.kind !== "available") return;
    expect(result.urgent).toBe(true);
  });

  it("urgent matching is case-insensitive and tolerates whitespace", async () => {
    checkMock.mockResolvedValueOnce({
      version: "0.2.2",
      body: "  uRgEnT: critical fix",
      downloadAndInstall: vi.fn(),
    });
    const result = await checkForUpdate();
    if (result.kind !== "available") throw new Error("expected available");
    expect(result.urgent).toBe(true);
  });

  it("error path → kind: error with message (loud)", async () => {
    checkMock.mockRejectedValueOnce(new Error("network down"));
    const result = await checkForUpdate({ silent: false });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toBe("network down");
  });

  it("'no release JSON' error classifies as `unconfigured`, not error", async () => {
    // Tauri's updater plugin throws this exact phrase when the
    // configured endpoint 404s or returns non-manifest JSON. For a
    // freshly-forked install where releases haven't been published
    // yet this is the expected steady state — the UI should render
    // a friendly "auto-updates aren't enabled" instead of a scary
    // last-check-failed banner.
    checkMock.mockRejectedValueOnce(
      new Error(
        "Could not fetch a valid release JSON from the remote",
      ),
    );
    const result = await checkForUpdate({ silent: false });
    expect(result.kind).toBe("unconfigured");
    if (result.kind !== "unconfigured") return;
    expect(result.reason).toMatch(/release json/i);
  });

  it("error path during silent check → idle (no banner)", async () => {
    checkMock.mockRejectedValueOnce(new Error("transient"));
    await checkForUpdate({ silent: true });
    expect(getUpdateState().kind).toBe("idle");
  });

  it("non-Error exception is normalized to a string message", async () => {
    checkMock.mockRejectedValueOnce("plain string error");
    const result = await checkForUpdate({ silent: false });
    if (result.kind !== "error") throw new Error("expected error");
    expect(result.message).toBe("plain string error");
  });

  it("guard: re-entry while checking returns the in-flight state", async () => {
    // Make check hang on the first call. The second call must see
    // kind: "checking" and return immediately without entering the
    // try/catch path.
    let resolveFirst: (v: null) => void = () => {};
    checkMock.mockImplementationOnce(
      () =>
        new Promise<null>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const first = checkForUpdate({ silent: true });
    // Yield the microtask queue once so the first call gets through
    // its set({kind: "checking"}) before the second call enters.
    await new Promise((r) => setTimeout(r, 0));
    const second = await checkForUpdate({ silent: true });
    expect(second.kind).toBe("checking");
    // Resolve the first so the test doesn't leak a pending promise.
    resolveFirst(null);
    await first;
  });
});

describe("downloadAvailableUpdate", () => {
  it("no-op when state isn't available", async () => {
    const result = await downloadAvailableUpdate();
    expect(result.kind).toBe("idle");
  });

  it("transitions through downloading → installing on Started/Progress/Finished events", async () => {
    let progressCb: (e: unknown) => void = () => {};
    const downloadAndInstall = vi.fn(
      async (cb: (e: unknown) => void) => {
        progressCb = cb;
        progressCb({ event: "Started", data: { contentLength: 1024 } });
        progressCb({ event: "Progress", data: { chunkLength: 512 } });
        progressCb({ event: "Finished" });
      },
    );
    checkMock.mockResolvedValue({
      version: "0.3.0",
      body: "",
      downloadAndInstall,
    });
    await checkForUpdate();
    await downloadAvailableUpdate();
    expect(getUpdateState().kind).toBe("installing");
    expect(downloadAndInstall).toHaveBeenCalledOnce();
  });

  it("download error surfaces as kind: error", async () => {
    const downloadAndInstall = vi
      .fn()
      .mockRejectedValueOnce(new Error("write to /Applications/ denied"));
    checkMock.mockResolvedValue({
      version: "0.3.1",
      body: "",
      downloadAndInstall,
    });
    await checkForUpdate();
    await downloadAvailableUpdate();
    const state = getUpdateState();
    expect(state.kind).toBe("error");
    if (state.kind !== "error") return;
    expect(state.message).toMatch(/denied/);
  });

  it("download progress with no contentLength reports bytes-so-far without total", async () => {
    let progressCb: (e: unknown) => void = () => {};
    const downloadAndInstall = vi.fn(async (cb: (e: unknown) => void) => {
      progressCb = cb;
      // Started event without contentLength.
      progressCb({ event: "Started", data: {} });
      progressCb({ event: "Progress", data: { chunkLength: 256 } });
      // Capture state mid-download (before Finished).
    });
    checkMock.mockResolvedValue({
      version: "0.3.2",
      body: "",
      downloadAndInstall,
    });
    await checkForUpdate();
    await downloadAvailableUpdate();
    // After all events, we land in installing if Finished fired,
    // or in downloading otherwise. We exercised Started + Progress
    // without Finished; expected state is downloading with bytesTotal=null.
    const state = getUpdateState();
    expect(state.kind).toBe("downloading");
    if (state.kind !== "downloading") return;
    expect(state.bytesTotal).toBeNull();
    expect(state.bytesDone).toBe(256);
  });
});

describe("relaunchToInstall", () => {
  it("calls the plugin's relaunch", async () => {
    relaunchMock.mockResolvedValueOnce(undefined);
    await relaunchToInstall();
    expect(relaunchMock).toHaveBeenCalledOnce();
  });
});
