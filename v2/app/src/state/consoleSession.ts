/**
 * PRD-116 §4.3.1 — "When the user navigates away from the Console
 * surface (clicks People, switches to Cmd+K, etc.), in-flight
 * sessions keep running."
 *
 * The Rust manager already keeps the PTY alive across surface mounts
 * — it's the React component's `useEffect` cleanup that was killing
 * the child on every nav. This store hoists session state above the
 * surface mount so the component can re-attach the existing xterm
 * DOM + handle when the user comes back.
 *
 * Storage shape, kept module-local (not in Redux/context, just a
 * mutable object behind an event):
 *
 *   - `handle`: the Rust-side opaque session id from `console_open`
 *   - `term`: the live xterm Terminal instance — preserved across
 *     unmounts so scrollback survives navigation
 *   - `fit`: the FitAddon attached to the term (so resize logic
 *     doesn't have to re-create one on remount)
 *   - `meta`: the OpenResult describing the session (cwd, argv, mode)
 *   - `dataUnlisten` / `exitUnlisten`: live Tauri event subscriptions;
 *     these stay connected across remounts so output chunks aren't
 *     dropped when the user is on another surface
 *   - `exited`: true once the PTY child exits (frontend renders the
 *     "session ended" banner; the term is still scrollable)
 *
 * Subscribers (currently just Console.tsx) call `subscribe(callback)`
 * and re-read on each event. The store is intentionally tiny — no
 * undo history, no replay; the Rust side already streams raw bytes
 * the term re-renders directly.
 */

// xterm types stay anonymous here: importing them at module top would
// pull the heavy bundle into the cold path. We type the slots as
// `unknown` and the consumer (Console.tsx) does the cast.
import type { UnlistenFn } from "@tauri-apps/api/event";

type OpenMeta = {
  handle: string;
  mode: "raw" | "chat";
  binary_path: string;
  cwd: string;
  argv: string[];
};

export type ConsoleSession = {
  handle: string;
  term: unknown;
  fit: unknown;
  meta: OpenMeta;
  dataUnlisten: UnlistenFn;
  exitUnlisten: UnlistenFn;
  exited: boolean;
  exitReason?: string;
};

let active: ConsoleSession | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

/** Read the current session, or null if none is running. */
export function getActiveSession(): ConsoleSession | null {
  return active;
}

/** Replace the active session. Pass null to clear. */
export function setActiveSession(s: ConsoleSession | null): void {
  active = s;
  emit();
}

/** Mark the current session as exited (PTY child closed). */
export function markExited(reason?: string): void {
  if (!active) return;
  active = { ...active, exited: true, exitReason: reason };
  emit();
}

/**
 * Subscribe to session changes — useSyncExternalStore-friendly.
 * Returns the unsubscribe function.
 */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Tear down the active session — unsubscribes both event listeners,
 * disposes the terminal, and clears the store. Caller is responsible
 * for invoking `console_close` on the backend; this only handles
 * frontend state.
 */
export function disposeActiveSession(): void {
  if (!active) return;
  try {
    active.dataUnlisten();
  } catch {
    // best-effort
  }
  try {
    active.exitUnlisten();
  } catch {
    // best-effort
  }
  try {
    (active.term as { dispose?: () => void } | null)?.dispose?.();
  } catch {
    // best-effort
  }
  active = null;
  emit();
}
