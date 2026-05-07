/**
 * Tiptap editor: find-in-doc helpers (CP3 / Cmd+F).
 *
 * Text-only matching against the rendered ProseMirror document. No DOM
 * mutation, no decoration plugin — we walk the doc state via
 * `descendants` and turn the offsets into selection ranges. The editor's
 * existing selection styling is the highlight; cycling between matches
 * is `setTextSelection` + `scrollIntoView`.
 *
 * Pure functions on top so the matcher can be unit-tested without a
 * mounted editor.
 */

import type { Editor } from "@tiptap/react";

export type FindMatch = {
  /** ProseMirror "from" offset, inclusive. */
  from: number;
  /** ProseMirror "to" offset, exclusive. */
  to: number;
};

/**
 * Find all case-insensitive occurrences of `query` in the editor
 * document, returning ProseMirror absolute offsets. Matches that span
 * a node boundary are skipped — we only consider text contiguous within
 * a single text node so the offsets always describe a valid selection.
 */
export function findMatches(editor: Editor | null, query: string): FindMatch[] {
  if (!editor) return [];
  const q = query.toLowerCase();
  if (q.length === 0) return [];
  const matches: FindMatch[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText) return;
    const text = node.text ?? "";
    const lower = text.toLowerCase();
    let i = 0;
    while (i <= lower.length - q.length) {
      const idx = lower.indexOf(q, i);
      if (idx < 0) break;
      matches.push({ from: pos + idx, to: pos + idx + q.length });
      i = idx + q.length;
    }
  });
  return matches;
}

/**
 * Move the editor selection to the given match and scroll it into view.
 * Idempotent — calling twice with the same match is a no-op visually
 * (selection collapses to the same range).
 */
export function focusMatch(editor: Editor | null, match: FindMatch): void {
  if (!editor) return;
  editor
    .chain()
    .focus()
    .setTextSelection({ from: match.from, to: match.to })
    .scrollIntoView()
    .run();
}
