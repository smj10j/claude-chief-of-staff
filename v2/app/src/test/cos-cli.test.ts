import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

/**
 * End-to-end-ish test for the `cos` shell wrapper. We can't test
 * subcommands that touch the v1 SQLite from inside a vitest run
 * (each one would fork the bash + Node task-cli and require the
 * project's content tree to be intact), but we CAN verify:
 *   - help output advertises every subcommand we ship
 *   - unknown subcommands fail loudly with non-zero exit
 *   - the `done` / `add` shortcuts validate their args before
 *     delegating to the task CLI
 *
 * These are the kinds of regressions that bite when someone renames
 * a subcommand in code but forgets the doc + the dispatch case.
 */

const COS = resolve(__dirname, "../../../../bin/cos");

function runCos(args: string[]): {
  stdout: string;
  stderr: string;
  code: number;
} {
  try {
    const stdout = execFileSync(COS, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, stderr: "", code: 0 };
  } catch (err) {
    const e = err as {
      status?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      code: e.status ?? -1,
    };
  }
}

describe("cos CLI (B5/B6/B7 shell surface)", () => {
  // Skip when the script isn't checked out (e.g. dist-only check).
  const present = existsSync(COS);

  it.runIf(present)(
    "`cos help` prints every documented subcommand",
    () => {
      const { stdout, code } = runCos(["help"]);
      expect(code).toBe(0);
      // Prove the help text actually lists each subcommand we ship.
      // If a future commit drops one from the doc but keeps it in
      // dispatch (or vice versa), this test fires.
      for (const sub of [
        "task list",
        "brief",
        "prep",
        "triage",
        "events today",
        "check",
        "export",
        "schedule install",
        "open",
        "status",
        "search",
        "done",
        "add",
        "digest",
      ]) {
        expect(stdout).toContain(sub);
      }
    },
  );

  it.runIf(present)(
    "`cos digest` without a path complains and exits non-zero",
    () => {
      const r = runCos(["digest"]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/missing session path/i);
    },
  );

  it.runIf(present)(
    "`cos digest` rejects absolute paths and '..' segments",
    () => {
      const abs = runCos(["digest", "/etc/passwd"]);
      expect(abs.code).not.toBe(0);
      const dotdot = runCos(["digest", "../escape.md"]);
      expect(dotdot.code).not.toBe(0);
    },
  );

  it.runIf(present)(
    "unknown top-level subcommand exits non-zero with a message",
    () => {
      const r = runCos(["definitely-not-a-subcommand"]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/unknown subcommand/i);
    },
  );

  it.runIf(present)(
    "`cos done` without an id complains and exits non-zero",
    () => {
      const r = runCos(["done"]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/missing task id/i);
    },
  );

  it.runIf(present)(
    "`cos add` without a title complains and exits non-zero",
    () => {
      const r = runCos(["add"]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/missing title/i);
    },
  );

  it.runIf(present)(
    "`cos open` without a path complains and exits non-zero",
    () => {
      const r = runCos(["open"]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/missing path/i);
    },
  );

  it.runIf(present)(
    "`cos open` rejects an absolute path or '..' segment",
    () => {
      const abs = runCos(["open", "/etc/passwd"]);
      expect(abs.code).not.toBe(0);
      expect(abs.stderr).toMatch(/absolute path|refusing/i);
      const dotdot = runCos(["open", "../escape.md"]);
      expect(dotdot.code).not.toBe(0);
    },
  );

  it.runIf(present)(
    "`cos search` without a query complains and exits non-zero",
    () => {
      const r = runCos(["search"]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/missing query/i);
    },
  );
});
