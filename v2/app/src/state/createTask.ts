import { invoke } from "@tauri-apps/api/core";

import { type V1Task } from "../surfaces/Work";

export type CreateTaskOutcome = {
  task: V1Task | null;
  error: string | null;
  /** Set when the Claude-parse step failed but we created with the raw
   *  title anyway. UI surfaces this as a soft warning. */
  parseFailed: boolean;
};

export type ParsedTask = {
  title: string;
  priority: string;
  due: string | null;
  project: string | null;
  tags: string[];
  notes: string | null;
};

/**
 * Single source of truth for "make a v1 task from a free-form string".
 * Used by both the Work-surface inline row and the global Quick Capture
 * modal. Pulls the input through claude_parse_task when requested, then
 * posts to v1_tasks_create. Always returns rather than throws so callers
 * can render an inline error without try/catch boilerplate.
 *
 * The parse-failure path is soft: if Claude can't parse, we still create
 * with the raw title and flag `parseFailed=true` in the result so the UI
 * can surface it. Losing the user's input over a parse hiccup is worse
 * than landing it half-structured.
 */
export async function createTaskFromText(
  text: string,
  parseWithClaude: boolean,
): Promise<CreateTaskOutcome> {
  const trimmed = text.trim();
  if (!trimmed) {
    return { task: null, error: "title is empty", parseFailed: false };
  }
  let input: Record<string, unknown> = { title: trimmed };
  let parseFailed = false;
  if (parseWithClaude) {
    try {
      const parsed = await invoke<ParsedTask>("claude_parse_task", {
        text: trimmed,
      });
      input = {
        title: parsed.title || trimmed,
        priority: parsed.priority,
        due: parsed.due,
        project: parsed.project,
        tags: parsed.tags,
        notes: parsed.notes,
      };
    } catch {
      // Fall through with raw title; surface as soft warning.
      parseFailed = true;
    }
  }
  try {
    const task = await invoke<V1Task>("v1_tasks_create", { input });
    return { task, error: null, parseFailed };
  } catch (error) {
    return { task: null, error: String(error), parseFailed };
  }
}
