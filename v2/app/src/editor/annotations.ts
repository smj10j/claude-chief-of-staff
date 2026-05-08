import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Editor } from "@tiptap/react";

/**
 * Tiptap extension that highlights annotation ranges as inline
 * decorations. Decorations are layered on top of the document — they
 * don't modify content, so the editor's existing autosave + audit
 * pipeline keeps working unchanged.
 *
 * Annotations are positioned by re-finding their `text` span inside
 * the live document (anchored by short before/after excerpts when the
 * `text` itself is ambiguous). M2a is read-only; M2b will add the
 * bubble menu and write path.
 */

export type AnnotationItem = {
  id: string;
  text: string;
  comment?: string;
  textBefore?: string;
  textAfter?: string;
  createdAt?: string;
  processedAt?: string | null;
};

const pluginKey = new PluginKey<{ items: AnnotationItem[] }>(
  "cos-annotations",
);

export interface AnnotationsOptions {
  initial: AnnotationItem[];
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    cosAnnotations: {
      setAnnotations: (items: AnnotationItem[]) => ReturnType;
    };
  }
}

export const Annotations = Extension.create<AnnotationsOptions>({
  name: "cosAnnotations",

  addOptions() {
    return { initial: [] };
  },

  addCommands() {
    return {
      setAnnotations:
        (items: AnnotationItem[]) =>
        ({ tr, dispatch }) => {
          if (dispatch) {
            tr.setMeta(pluginKey, { items });
            dispatch(tr);
          }
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    const initial = this.options.initial;
    return [
      new Plugin<{ items: AnnotationItem[] }>({
        key: pluginKey,
        state: {
          init: () => ({ items: initial }),
          apply(tr, prev) {
            const meta = tr.getMeta(pluginKey);
            if (meta) return meta as { items: AnnotationItem[] };
            return prev;
          },
        },
        props: {
          decorations(state) {
            const data = pluginKey.getState(state);
            if (!data || data.items.length === 0) return DecorationSet.empty;
            const text = state.doc.textContent;
            const decos: Decoration[] = [];
            for (const a of data.items) {
              // Processed annotations are removed from the sidecar by
              // /process-ui-annotations. Any leftover processedAt entry
              // (legacy data from the dim-on-process era) should render
              // as if it were already cleaned up — hide, don't dim.
              if (a.processedAt) continue;
              const range = locate(text, a);
              if (!range) continue;
              // Convert flat-text offsets to ProseMirror positions.
              // textContent walks the doc in document order, so a
              // textContent index N maps to a doc position with the
              // same character count of leaf text — but doc positions
              // also include node tokens. We resolve via a per-node
              // walk below.
              const docRange = textOffsetToDocRange(
                state.doc,
                range.start,
                range.end,
              );
              if (!docRange) continue;
              decos.push(
                Decoration.inline(
                  docRange.from,
                  docRange.to,
                  {
                    class: "cos-annotation",
                    "data-annotation-id": a.id,
                    title: a.comment || "Annotation",
                  },
                ),
              );
            }
            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
    ];
  },
});

/**
 * Generate a short id matching v1's shape (8 random alphanumerics).
 */
export function newAnnotationId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Read the current annotation list from the editor's plugin state
 * without re-serializing through React. Returns a fresh array (safe to
 * mutate before passing back through setAnnotations).
 */
export function readAnnotations(editor: Editor): AnnotationItem[] {
  const data = pluginKey.getState(editor.state);
  return data ? [...data.items] : [];
}

/**
 * Build an annotation from a Tiptap selection: capture the selected
 * text plus 30 chars of context on each side. The context anchors the
 * highlight after subsequent edits via the `locate()` heuristic.
 */
export function annotationFromSelection(
  editor: Editor,
  comment: string,
): AnnotationItem | null {
  const { from, to } = editor.state.selection;
  if (from === to) return null;
  const text = editor.state.doc.textBetween(from, to, "\n");
  if (text.trim().length === 0) return null;

  // Context excerpts via flat textContent indexing.
  const flat = editor.state.doc.textContent;
  const flatStart = flatOffsetForPos(editor.state.doc, from);
  const flatEnd = flatOffsetForPos(editor.state.doc, to);
  const before = flat.slice(Math.max(0, flatStart - 30), flatStart);
  const after = flat.slice(flatEnd, Math.min(flat.length, flatEnd + 30));

  return {
    id: newAnnotationId(),
    text,
    comment,
    textBefore: before,
    textAfter: after,
    createdAt: new Date().toISOString(),
    processedAt: null,
  };
}

/**
 * Find which annotation, if any, contains the cursor. Used by the
 * bubble menu to show "Remove note" when the cursor sits inside a
 * highlighted span.
 */
export function annotationAtCursor(editor: Editor): AnnotationItem | null {
  const { from, to } = editor.state.selection;
  if (from !== to) return null;
  const flat = editor.state.doc.textContent;
  const flatPos = flatOffsetForPos(editor.state.doc, from);
  const items = readAnnotations(editor);
  for (const a of items) {
    const range = locate(flat, a);
    if (!range) continue;
    if (flatPos >= range.start && flatPos <= range.end) return a;
  }
  return null;
}

function flatOffsetForPos(
  doc: import("@tiptap/pm/model").Node,
  pos: number,
): number {
  let seen = 0;
  let result = 0;
  let found = false;
  doc.descendants((node, nodePos) => {
    if (found) return false;
    if (!node.isText) return true;
    const len = node.text?.length ?? 0;
    if (pos >= nodePos && pos <= nodePos + len) {
      result = seen + (pos - nodePos);
      found = true;
      return false;
    }
    seen += len;
    return true;
  });
  return found ? result : seen;
}

/**
 * Find an annotation's range inside the live doc text. Tries:
 *   1. Verbatim search for `text`.
 *   2. If multiple matches, disambiguate by `textBefore`/`textAfter`.
 *   3. If no match, return null (caller skips the decoration).
 */
function locate(
  doc: string,
  a: AnnotationItem,
): { start: number; end: number } | null {
  if (!a.text) return null;
  const before = a.textBefore ?? "";
  const after = a.textAfter ?? "";

  // Anchor by before+text+after when both excerpts are non-empty.
  if (before && after) {
    const composite = before + a.text + after;
    const i = doc.indexOf(composite);
    if (i >= 0) {
      return { start: i + before.length, end: i + before.length + a.text.length };
    }
  }
  // Then by text+after.
  if (after) {
    const composite = a.text + after;
    const i = doc.indexOf(composite);
    if (i >= 0) return { start: i, end: i + a.text.length };
  }
  // Then by before+text.
  if (before) {
    const composite = before + a.text;
    const i = doc.indexOf(composite);
    if (i >= 0) return { start: i + before.length, end: i + before.length + a.text.length };
  }
  // Last resort: first verbatim occurrence of `text`.
  const i = doc.indexOf(a.text);
  if (i >= 0) return { start: i, end: i + a.text.length };
  return null;
}

/**
 * Convert (textOffset start, end) — both in flat textContent space —
 * to ProseMirror doc positions. Walks the doc; for each text node,
 * tracks how many leaf characters have been seen and maps to ProseMirror
 * positions when the offset falls inside the node.
 */
function textOffsetToDocRange(
  doc: import("@tiptap/pm/model").Node,
  start: number,
  end: number,
): { from: number; to: number } | null {
  let from: number | null = null;
  let to: number | null = null;
  let seen = 0;

  doc.descendants((node, pos) => {
    if (from !== null && to !== null) return false;
    if (!node.isText) return true;
    const len = node.text?.length ?? 0;
    const nodeStart = seen;
    const nodeEnd = seen + len;
    if (from === null && start >= nodeStart && start <= nodeEnd) {
      from = pos + (start - nodeStart);
    }
    if (to === null && end >= nodeStart && end <= nodeEnd) {
      to = pos + (end - nodeStart);
    }
    seen = nodeEnd;
    return true;
  });

  if (from === null || to === null || to <= from) return null;
  return { from, to };
}
