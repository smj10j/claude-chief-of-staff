/**
 * PRD-116 §4.7 — "Run in Console" action contract.
 *
 * Any surface can emit `cos:console-run-here` with a seed payload;
 * the Console surface listens for it, navigates to itself if not
 * already active, opens a chat session pre-populated with the seed
 * text, and (when `auto_submit: true` and the seed is read-only)
 * fires the first turn automatically.
 *
 * Auto-submit is gated to read-only seeds — the contract itself
 * doesn't enforce, but callers should only set it for prompts that
 * imply no Edit/Write/Bash side-effects (e.g., "summarize this
 * thread", "explain this file"). The "you can stop me" 3-second
 * countdown in the renderer is the user's escape hatch.
 */

export type ConsoleRunHerePayload = {
  /** The user-turn text to seed. Markdown OK. */
  prompt: string;
  /** Optional cwd override (defaults to workspace root). */
  cwd?: string;
  /** Reference chips that should render above the prompt — e.g.,
   *  "[1:1 prep doc with @alice]". The Console pins these as a
   *  preamble in the input area before the user submits. */
  references?: { label: string; relPath?: string }[];
  /** Auto-submit the first turn. Caller asserts this is a read-only
   *  prompt; the Console shows a 3-second cancel pip before firing. */
  auto_submit?: boolean;
  /** Optional model override. */
  model?: string;
  /** Optional permission_mode override. */
  mode?: string;
};

export const CONSOLE_RUN_HERE_EVENT = "cos:console-run-here";

export function dispatchConsoleRunHere(p: ConsoleRunHerePayload): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<ConsoleRunHerePayload>(CONSOLE_RUN_HERE_EVENT, {
      detail: p,
    }),
  );
  // Also navigate to the Console surface — the listener inside
  // Console handles the actual seed.
  window.dispatchEvent(
    new CustomEvent("cos:goto", {
      detail: { surface: "console" },
    }),
  );
}
