import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { type Editor } from "@tiptap/react";

import {
  annotationAtCursor,
  annotationFromSelection,
  type AnnotationItem,
  readAnnotations,
} from "./annotations";

/**
 * Fires whenever the bubble adds or removes an annotation. The toolbar
 * button in DocEditor listens to this so the "Process N annotations"
 * count updates as soon as a note is left — no editor reload required.
 */
export const ANNOTATIONS_CHANGED_EVENT = "cos:annotations-changed";

export type AnnotationsChangedDetail = {
  relPath: string;
  items: AnnotationItem[];
};

function publishAnnotationsChanged(relPath: string, items: AnnotationItem[]) {
  window.dispatchEvent(
    new CustomEvent<AnnotationsChangedDetail>(ANNOTATIONS_CHANGED_EVENT, {
      detail: { relPath, items },
    }),
  );
}

/**
 * Floating action panel for annotations. Three modes:
 *   - "select"        — non-empty selection. Shows a "Leave note for
 *                        Claude" button.
 *   - "compose"       — after the user clicks Leave note. Shows an
 *                        inline input + Save / Cancel.
 *   - "in-annotation" — collapsed cursor inside an existing
 *                        annotation. Shows the comment + Remove.
 *
 * Position is computed off the editor's current selection rect via
 * the EditorView. Clamped to viewport so the bubble never lands
 * above the top of the screen or off the right edge. Background is
 * fully opaque so it's readable against any underlying text.
 */
export function AnnotationBubble({
  editor,
  relPath,
}: {
  editor: Editor | null;
  relPath: string;
}) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [mode, setMode] = useState<
    "select" | "compose" | "in-annotation" | null
  >(null);
  const [hoverAnno, setHoverAnno] = useState<AnnotationItem | null>(null);
  const [composeText, setComposeText] = useState("");
  const composeInputRef = useRef<HTMLInputElement | null>(null);
  // Snapshot the selection at the moment compose mode opens, so the
  // input getting focus doesn't lose it. We use this snapshot when
  // saving even if the editor's live selection is now elsewhere.
  const composeRangeRef = useRef<{ from: number; to: number } | null>(null);

  useEffect(() => {
    if (!editor) return;
    function update() {
      if (!editor) return;
      // Don't disturb compose mode just because focus shifted to the
      // input. We treat `compose` as sticky until Save / Cancel.
      if (mode === "compose") return;
      const { from, to, empty } = editor.state.selection;
      const view = editor.view;
      if (!view.hasFocus() && empty) {
        setPos(null);
        setMode(null);
        return;
      }
      if (empty) {
        const at = annotationAtCursor(editor);
        if (at) {
          const rect = view.coordsAtPos(from);
          setPos(clampViewport({ top: rect.top - 48, left: rect.left }));
          setHoverAnno(at);
          setMode("in-annotation");
        } else {
          setPos(null);
          setMode(null);
        }
        return;
      }
      const start = view.coordsAtPos(from);
      const end = view.coordsAtPos(to);
      const top = Math.min(start.top, end.top) - 48;
      const left = Math.min(start.left, end.left);
      setPos(clampViewport({ top, left }));
      setMode("select");
    }
    editor.on("selectionUpdate", update);
    editor.on("focus", update);
    update();
    return () => {
      editor.off("selectionUpdate", update);
      editor.off("focus", update);
    };
  }, [editor, mode]);

  // Auto-focus the input when entering compose mode.
  useEffect(() => {
    if (mode === "compose" && composeInputRef.current) {
      composeInputRef.current.focus();
    }
  }, [mode]);

  if (!editor || !pos || !mode) return null;

  const openCompose = () => {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    if (from === to) return;
    composeRangeRef.current = { from, to };
    setComposeText("");
    setMode("compose");
  };

  const cancelCompose = () => {
    composeRangeRef.current = null;
    setComposeText("");
    setMode(null);
    setPos(null);
  };

  const submitCompose = async () => {
    const comment = composeText.trim();
    if (!comment || !editor) {
      cancelCompose();
      return;
    }
    // Re-apply the original selection so the annotation captures the
    // user's selected text — focus shifted to the input in between.
    const range = composeRangeRef.current;
    if (range) {
      editor.commands.setTextSelection({ from: range.from, to: range.to });
    }
    const next = annotationFromSelection(editor, comment);
    if (!next) {
      cancelCompose();
      return;
    }
    const all = [...readAnnotations(editor), next];
    try {
      await invoke("annotations_save", { relPath, items: all });
      editor.commands.setAnnotations(all);
      publishAnnotationsChanged(relPath, all);
    } catch (error) {
      window.alert(`Could not save annotation: ${String(error)}`);
    } finally {
      cancelCompose();
    }
  };

  const removeCurrent = async () => {
    if (!hoverAnno || !editor) return;
    const all = readAnnotations(editor).filter((a) => a.id !== hoverAnno.id);
    try {
      await invoke("annotations_save", { relPath, items: all });
      editor.commands.setAnnotations(all);
      publishAnnotationsChanged(relPath, all);
    } catch (error) {
      window.alert(`Could not remove annotation: ${String(error)}`);
    } finally {
      setPos(null);
      setMode(null);
      setHoverAnno(null);
    }
  };

  return (
    <div
      className="cos-annotation-bubble"
      style={{ top: pos.top, left: pos.left }}
      // preventDefault on the bubble's own mousedown so the editor
      // doesn't blur when the user clicks. Buttons inside still get
      // their click events because we don't preventDefault on them.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) e.preventDefault();
      }}
    >
      {mode === "select" && (
        <button
          type="button"
          className="cos-btn"
          // mousedown handler fires before blur, so the action runs
          // even if click would have been swallowed.
          onMouseDown={(e) => {
            e.preventDefault();
            openCompose();
          }}
        >
          📝 Leave note for Claude
        </button>
      )}
      {mode === "compose" && (
        <>
          <input
            ref={composeInputRef}
            type="text"
            className="cos-annotation-bubble-input"
            placeholder="Note for Claude…"
            value={composeText}
            onChange={(e) => setComposeText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitCompose();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelCompose();
              }
            }}
          />
          <button
            type="button"
            className="cos-btn"
            onMouseDown={(e) => {
              e.preventDefault();
              submitCompose();
            }}
          >
            save
          </button>
          <button
            type="button"
            className="cos-btn cos-btn-ghost"
            onMouseDown={(e) => {
              e.preventDefault();
              cancelCompose();
            }}
          >
            cancel
          </button>
        </>
      )}
      {mode === "in-annotation" && hoverAnno && (
        <>
          <span
            className="cos-annotation-bubble-comment"
            title={hoverAnno.comment ?? ""}
          >
            {(() => {
              const c = hoverAnno.comment ?? "";
              if (c.length === 0) return "(no comment)";
              return c.length > 60 ? c.slice(0, 57) + "…" : c;
            })()}
          </span>
          <button
            type="button"
            className="cos-btn cos-btn-ghost"
            onMouseDown={(e) => {
              e.preventDefault();
              removeCurrent();
            }}
          >
            remove
          </button>
        </>
      )}
    </div>
  );
}

/**
 * Keep the bubble fully on-screen. Top-edge clamps to ~12px so the
 * shadow doesn't get cut off; right-edge to viewport width minus an
 * estimated bubble width. The estimate is conservative — the actual
 * width depends on which mode is showing.
 */
function clampViewport(p: { top: number; left: number }): {
  top: number;
  left: number;
} {
  const minTop = 12;
  const maxLeft = Math.max(12, window.innerWidth - 480);
  return {
    top: Math.max(minTop, p.top),
    left: Math.max(12, Math.min(p.left, maxLeft)),
  };
}
