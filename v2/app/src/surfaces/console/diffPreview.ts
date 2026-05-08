/**
 * PRD-116 Phase 2.5 — minimal inline-diff renderer for tool-call
 * cards that touch files (Edit / Write / MultiEdit).
 *
 * Pure: takes the tool's input shape + output text, returns a list
 * of diff lines the renderer paints. Not a full LCS-based diff; for
 * Edit, claude already gives us exact `old_string` / `new_string`
 * pairs, so we just render the contrast directly. For Write, we
 * render the full file body as additions.
 */

export type DiffLine =
  | { kind: "context"; text: string }
  | { kind: "del"; text: string }
  | { kind: "add"; text: string }
  | { kind: "meta"; text: string };

/**
 * Render an Edit tool call: old_string → new_string. Strips trailing
 * newlines from each side to keep the rendered block tight.
 */
export function renderEditDiff(
  input: unknown,
): { lines: DiffLine[]; filePath: string | null } {
  const r = (input ?? {}) as Record<string, unknown>;
  const filePath = typeof r.file_path === "string" ? r.file_path : null;
  const oldString =
    typeof r.old_string === "string" ? r.old_string : "";
  const newString =
    typeof r.new_string === "string" ? r.new_string : "";
  const lines: DiffLine[] = [];
  for (const t of oldString.split("\n")) lines.push({ kind: "del", text: t });
  for (const t of newString.split("\n")) lines.push({ kind: "add", text: t });
  return { lines, filePath };
}

/**
 * Render a Write tool call: every line is an addition. The file path
 * is always present in the input.
 */
export function renderWriteDiff(
  input: unknown,
): { lines: DiffLine[]; filePath: string | null } {
  const r = (input ?? {}) as Record<string, unknown>;
  const filePath = typeof r.file_path === "string" ? r.file_path : null;
  const content = typeof r.content === "string" ? r.content : "";
  const lines: DiffLine[] = content
    .split("\n")
    .map((text) => ({ kind: "add" as const, text }));
  return { lines, filePath };
}

/**
 * Render a MultiEdit tool call: each `edits` entry is an
 * old_string → new_string pair, separated by a meta line.
 */
export function renderMultiEditDiff(
  input: unknown,
): { lines: DiffLine[]; filePath: string | null } {
  const r = (input ?? {}) as Record<string, unknown>;
  const filePath = typeof r.file_path === "string" ? r.file_path : null;
  const edits = Array.isArray(r.edits) ? r.edits : [];
  const lines: DiffLine[] = [];
  edits.forEach((entry, idx) => {
    if (!entry || typeof entry !== "object") return;
    const e = entry as Record<string, unknown>;
    const oldString = typeof e.old_string === "string" ? e.old_string : "";
    const newString = typeof e.new_string === "string" ? e.new_string : "";
    if (idx > 0) lines.push({ kind: "meta", text: "—" });
    for (const t of oldString.split("\n")) lines.push({ kind: "del", text: t });
    for (const t of newString.split("\n")) lines.push({ kind: "add", text: t });
  });
  return { lines, filePath };
}

/**
 * Counts of additions / deletions for the card header summary
 * ("+12 −3"). Excludes meta lines.
 */
export function countDiff(lines: DiffLine[]): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.kind === "add") added++;
    else if (l.kind === "del") removed++;
  }
  return { added, removed };
}
