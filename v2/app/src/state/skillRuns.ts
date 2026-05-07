import { useSyncExternalStore } from "react";

/**
 * App-level registry of skill runs in progress.
 *
 * Skills (the slash-command-driven Claude calls — prep-1on1, digest,
 * morning-briefing, person-refresh, org-generate) take 30s–3min and
 * absolutely must survive navigation. The originating subprocess in
 * Rust runs to completion regardless of React mount state, so the UI
 * needs a state owner that outlives any single surface.
 *
 * This module is that owner. Components that *trigger* a skill call
 * `runSkill(id, label, fn)`; components that want to *display* run
 * state subscribe via `useRun(id)` (or `useRunningCount()` for a
 * global indicator).
 *
 * Run IDs are slug-shaped strings the caller picks:
 *   - `org-generate`               (singleton)
 *   - `morning-briefing`           (singleton)
 *   - `person-refresh:<slug>`      (one per person)
 *   - `prep-1on1:<slug>`           (one per person)
 *   - `digest-meeting:<rel-path>`  (one per session file)
 */

export type RunState = {
  id: string;
  /** Human-readable label shown in the header indicator and tooltips. */
  label: string;
  state: "running" | "done" | "error";
  startedAt: number;
  finishedAt?: number;
  error?: string;
  /**
   * Counter incremented every time this id transitions to `done` or
   * `error`. Components observe the change to act exactly once on
   * completion (refetch, open file, dismiss spinner).
   */
  generation: number;
};

let runs: Map<string, RunState> = new Map();
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function setRun(id: string, next: RunState) {
  runs = new Map(runs);
  runs.set(id, next);
  emit();
}

function clearRun(id: string) {
  if (!runs.has(id)) return;
  runs = new Map(runs);
  runs.delete(id);
  emit();
}

/**
 * Run a skill, registering it in the store so any surface can show
 * progress. Re-entry on the same id while already running is a no-op
 * (returns the in-flight promise's eventual value would be ideal but
 * we throw instead — callers should disable their own buttons via
 * useRun(id).state to prevent this in practice).
 */
export async function runSkill<T>(
  id: string,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const existing = runs.get(id);
  if (existing?.state === "running") {
    throw new Error(`skill already running: ${id}`);
  }
  const generation = (existing?.generation ?? 0);
  // Capture the start of THIS run. Earlier code reused
  // `existing?.startedAt` for the wall-clock duration calc, which
  // was wrong: on the first run for a given id, `existing` is
  // undefined so the fallback Date.now() ran in both operands of
  // the subtraction → ranMs = 0 → notification never fired. The
  // bug was invisible until the user reported "Brief me finished
  // and no notification appeared."
  const startedAt = Date.now();
  setRun(id, {
    id,
    label,
    state: "running",
    startedAt,
    generation,
  });
  try {
    const result = await fn();
    setRun(id, {
      id,
      label,
      state: "done",
      startedAt,
      finishedAt: Date.now(),
      generation: generation + 1,
    });
    // Fire a native notification when a long-running skill finishes.
    // "Long-running" = strictly > 4s wall-clock — short skills (e.g.
    // task parse) don't deserve an interruption. Lazy import keeps
    // notifications module out of the cold-start path for tests
    // that mock the plugin away.
    const ranMs = Date.now() - startedAt;
    if (ranMs > 4000) {
      void notifyOnSkillDone(label, "completed");
    }
    return result;
  } catch (error) {
    setRun(id, {
      id,
      label,
      state: "error",
      startedAt,
      finishedAt: Date.now(),
      error: String(error),
      generation: generation + 1,
    });
    const ranMs = Date.now() - startedAt;
    if (ranMs > 4000) {
      void notifyOnSkillDone(label, "failed", String(error));
    }
    throw error;
  }
}

async function notifyOnSkillDone(
  label: string,
  outcome: "completed" | "failed",
  detail?: string,
): Promise<void> {
  try {
    const { notify } = await import("./notifications");
    await notify(
      `${label} ${outcome}`,
      outcome === "failed" ? detail : undefined,
    );
  } catch {
    /* notifications are decoration */
  }
}

/** Subscribe to a single run by id. Returns undefined if no run exists. */
export function useRun(id: string): RunState | undefined {
  return useSyncExternalStore(
    subscribe,
    () => runs.get(id),
    () => runs.get(id),
  );
}

/**
 * Cached array of currently-running runs. Memoized via a stable
 * identity selector — useSyncExternalStore needs the snapshot to
 * compare-equal between renders when nothing changed, so we keep the
 * last array and only recompute when the underlying map changes.
 */
let runningCache: { runs: Map<string, RunState>; arr: RunState[] } | null =
  null;
function selectRunning(): RunState[] {
  if (runningCache?.runs === runs) return runningCache.arr;
  const arr = Array.from(runs.values()).filter((r) => r.state === "running");
  runningCache = { runs, arr };
  return arr;
}

export function useRunning(): RunState[] {
  return useSyncExternalStore(subscribe, selectRunning, selectRunning);
}

export function useRunningCount(): number {
  return useRunning().length;
}

export function dismissRun(id: string) {
  clearRun(id);
}

/** Test/debug only — do not call from production code. */
export function _resetForTest() {
  runs = new Map();
  runningCache = null;
  emit();
}
