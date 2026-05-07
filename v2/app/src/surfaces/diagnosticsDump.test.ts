import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  collectDiagnosticsDump,
  statusValueOrError,
  type BackendInfo,
  type PingResult,
  type Status,
} from "./Settings";
import {
  resetInvokeMock,
  setInvokeHandlers,
} from "../test/invokeMock";

describe("statusValueOrError (B7-CP18)", () => {
  it("returns null for null state", () => {
    expect(statusValueOrError<BackendInfo>(null)).toBeNull();
  });

  it("returns 'pending' for a pending state", () => {
    expect(statusValueOrError({ kind: "pending" })).toBe("pending");
  });

  it("unwraps the value for an ok state", () => {
    const s: Status<BackendInfo> = {
      kind: "ok",
      value: {
        version: "v1.2.3",
        db_path: "/tmp/x",
        built_by: "User",
        built_with: "Claude Code",
      },
    };
    expect(statusValueOrError(s)).toEqual({
      version: "v1.2.3",
      db_path: "/tmp/x",
      built_by: "User",
      built_with: "Claude Code",
    });
  });

  it("wraps error.message in { error } for an error state", () => {
    const s: Status<BackendInfo> = { kind: "error", error: "boom" };
    expect(statusValueOrError(s)).toEqual({ error: "boom" });
  });
});

describe("collectDiagnosticsDump (B7-CP18)", () => {
  beforeEach(() => {
    resetInvokeMock();
  });
  afterEach(() => {
    resetInvokeMock();
  });

  const okBackend: Status<BackendInfo> = {
    kind: "ok",
    value: {
      version: "cos-app v0.1.0",
      db_path: "/tmp/cos.db",
      built_by: "User",
      built_with: "Claude Code",
    },
  };
  const okPing: Status<PingResult> = {
    kind: "ok",
    value: { rows: 3, last_write: "2026-04-25T10:00Z" },
  };
  const okKeychain: Status<string> = {
    kind: "ok",
    value: "roundtrip ok",
  };

  it("includes the timestamp + UI-state half + each successful backend probe", async () => {
    setInvokeHandlers({
      claude_status: () => ({ available: true, version: "x" }),
      install_status: () => ({ all_ok: true, checks: [] }),
      disk_health: () => ({ audit_rows: 5, blob_count: 2 }),
      db_encryption_status: () => ({ encrypted: false }),
    });
    const dump = await collectDiagnosticsDump({
      info: okBackend,
      ping: okPing,
      keychain: okKeychain,
    });
    expect(typeof dump.timestamp).toBe("string");
    expect(dump.backend).toEqual({
      version: "cos-app v0.1.0",
      db_path: "/tmp/cos.db",
      built_by: "User",
      built_with: "Claude Code",
    });
    expect(dump.db_ping).toEqual({
      rows: 3,
      last_write: "2026-04-25T10:00Z",
    });
    expect(dump.keychain).toBe("roundtrip ok");
    expect(dump.claude_status).toEqual({ available: true, version: "x" });
    expect(dump.disk_health).toEqual({ audit_rows: 5, blob_count: 2 });
    expect(dump.db_encryption_status).toEqual({ encrypted: false });
  });

  it("captures backend probe failures inline rather than throwing", async () => {
    setInvokeHandlers({
      claude_status: () => {
        throw new Error("offline");
      },
      install_status: () => ({ all_ok: true }),
      disk_health: () => {
        throw new Error("disk read failed");
      },
      db_encryption_status: () => ({ encrypted: true }),
    });
    const dump = await collectDiagnosticsDump({
      info: okBackend,
      ping: null,
      keychain: null,
    });
    expect(dump.claude_status).toEqual({ error: "Error: offline" });
    expect(dump.disk_health).toEqual({ error: "Error: disk read failed" });
    expect(dump.install_status).toEqual({ all_ok: true });
    expect(dump.db_ping).toBeNull();
    expect(dump.keychain).toBeNull();
  });

  it("serializes cleanly to JSON (bug-report-paste-ready)", async () => {
    setInvokeHandlers({
      claude_status: () => ({ available: false }),
      install_status: () => ({ all_ok: false }),
      disk_health: () => ({ blob_bytes: 1024 }),
      db_encryption_status: () => ({ encrypted: false }),
    });
    const dump = await collectDiagnosticsDump({
      info: okBackend,
      ping: okPing,
      keychain: okKeychain,
    });
    const text = JSON.stringify(dump, null, 2);
    expect(() => JSON.parse(text)).not.toThrow();
    expect(text).toContain("cos-app v0.1.0");
    expect(text).toContain("blob_bytes");
  });
});
