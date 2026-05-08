import { invoke } from "@tauri-apps/api/core";

/**
 * Frontend perf recorder. Pure ergonomics over the perf_record IPC.
 *
 * Two patterns:
 *   - `mark(kind, meta?)` returns a `done()` function that, when
 *     called, records the elapsed duration. Use this for synchronous
 *     window operations (view-switch, palette-open).
 *   - `time(kind, fn, meta?)` wraps an async function and records its
 *     duration. Use this for IPC measurement.
 *
 * Both are best-effort — if the backend is unreachable, the call
 * silently swallows the error so instrumenting a hot path doesn't
 * surface failures to the user.
 */

export type PerfKind =
  | "view-switch"
  | "palette-open"
  | "editor-input"
  | "ipc";

type Meta = Record<string, unknown> | undefined;

export function mark(
  kind: PerfKind,
  meta?: Meta,
): () => void {
  const start = performance.now();
  let recorded = false;
  return () => {
    if (recorded) return;
    recorded = true;
    const duration = performance.now() - start;
    void recordSample(kind, duration, meta);
  };
}

export async function time<T>(
  kind: PerfKind,
  fn: () => Promise<T>,
  meta?: Meta,
): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    const duration = performance.now() - start;
    void recordSample(kind, duration, meta);
  }
}

async function recordSample(
  kind: PerfKind,
  duration_ms: number,
  meta?: Meta,
): Promise<void> {
  try {
    await invoke("perf_record", {
      sample: {
        kind,
        duration_ms,
        at: new Date().toISOString(),
        meta: meta ?? null,
      },
    });
  } catch {
    // Best-effort — perf logging shouldn't break the app.
  }
}
