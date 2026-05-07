import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { type Editor } from "@tiptap/react";

import {
  ANNOTATIONS_CHANGED_EVENT,
  type AnnotationsChangedDetail,
} from "./AnnotationBubble";
import { type AnnotationItem } from "./annotations";

/**
 * Drawer-style list of every note on the current doc. Lives directly
 * below the editor toolbar and toggles on/off so it doesn't waste space
 * on docs without notes.
 *
 * Each row shows the user's comment and the snippet of highlighted text.
 * Clicking a row scrolls the editor to that annotation and selects it,
 * so User can jump between notes without scrolling.
 */
export type AnnotationFilterMode = "open" | "processed" | "all";

/**
 * Filter an annotation list by the panel's filter mode (B7-CP8).
 * Pure so tests can pin the rule without rendering the panel.
 */
export function filterAnnotations(
  items: AnnotationItem[],
  mode: AnnotationFilterMode,
): AnnotationItem[] {
  if (mode === "open") return items.filter((a) => !a.processedAt);
  if (mode === "processed") return items.filter((a) => Boolean(a.processedAt));
  return items;
}

type FilterMode = AnnotationFilterMode;

export function AnnotationsPanel({
  editor,
  relPath,
}: {
  editor: Editor | null;
  relPath: string;
}) {
  const [items, setItems] = useState<AnnotationItem[]>([]);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<FilterMode>("open");

  useEffect(() => {
    let cancelled = false;
    invoke<AnnotationItem[]>("annotations_list", { relPath })
      .then((list) => {
        if (!cancelled) setItems(list);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [relPath]);

  // Live updates: AnnotationBubble fires this event on save/remove; same
  // wiring DocEditor's count uses, just different consumer.
  useEffect(() => {
    function onChanged(e: Event) {
      const detail = (e as CustomEvent<AnnotationsChangedDetail>).detail;
      if (!detail || detail.relPath !== relPath) return;
      setItems(detail.items);
    }
    window.addEventListener(ANNOTATIONS_CHANGED_EVENT, onChanged);
    return () =>
      window.removeEventListener(ANNOTATIONS_CHANGED_EVENT, onChanged);
  }, [relPath]);

  const openItems = filterAnnotations(items, "open");
  const processedItems = filterAnnotations(items, "processed");
  const visible = filterAnnotations(items, filter);

  // Auto-collapse when the doc has no notes; otherwise default to
  // open if the user just left a note (count goes from 0 → 1).
  useEffect(() => {
    if (items.length === 0) setOpen(false);
  }, [items.length]);

  if (items.length === 0) return null;

  const jumpTo = (item: AnnotationItem) => {
    if (!editor) return;
    // Same locator we use in the Annotations extension: search the
    // doc's text for the annotation's anchor text. Simple here because
    // we don't need exact positions — Tiptap's find-and-replace API
    // would be heavier than the win.
    const text = editor.state.doc.textContent;
    const idx = text.indexOf(item.text);
    if (idx === -1) return;
    // Convert flat-text index to a ProseMirror position by walking
    // the doc and counting text characters.
    const pos = textIndexToDocPos(editor, idx);
    if (pos === null) return;
    editor
      .chain()
      .focus()
      .setTextSelection({ from: pos, to: pos + item.text.length })
      .scrollIntoView()
      .run();
  };

  const toggleLabel =
    filter === "open"
      ? `${openItems.length} open`
      : filter === "processed"
        ? `${processedItems.length} processed`
        : `${items.length} total`;

  return (
    <div className="cos-annotations-panel">
      <button
        type="button"
        className="cos-annotations-panel-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? "▾" : "▸"} {toggleLabel} annotation
        {visible.length === 1 ? "" : "s"}
      </button>
      {open && (
        <>
          <div
            className="cos-annotations-panel-filters"
            role="tablist"
            aria-label="Annotation filter"
          >
            {(
              [
                ["open", `Open (${openItems.length})`],
                ["processed", `Processed (${processedItems.length})`],
                ["all", `All (${items.length})`],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={filter === id}
                className={`cos-annotations-panel-filter${
                  filter === id ? " is-active" : ""
                }`}
                onClick={() => setFilter(id)}
              >
                {label}
              </button>
            ))}
          </div>
          {visible.length === 0 ? (
            <p className="cos-annotations-panel-empty">
              {filter === "open"
                ? "No open annotations."
                : filter === "processed"
                  ? "No processed annotations yet."
                  : "No annotations on this doc."}
            </p>
          ) : (
            <ul className="cos-annotations-panel-list" role="list">
              {visible.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    className={`cos-annotations-panel-row${
                      a.processedAt ? " is-processed" : ""
                    }`}
                    onClick={() => jumpTo(a)}
                    title={a.text}
                  >
                    <span className="cos-annotations-panel-comment">
                      {a.comment || "(no comment)"}
                    </span>
                    <span className="cos-annotations-panel-anchor">
                      {a.text.length > 80 ? a.text.slice(0, 77) + "…" : a.text}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function textIndexToDocPos(editor: Editor, textIndex: number): number | null {
  let consumed = 0;
  let result: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (result !== null) return false;
    if (node.isText) {
      const t = node.text ?? "";
      if (consumed + t.length >= textIndex) {
        result = pos + (textIndex - consumed);
        return false;
      }
      consumed += t.length;
    }
    return true;
  });
  return result;
}
