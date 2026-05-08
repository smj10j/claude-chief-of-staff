/**
 * Cmd+F find-in-doc (CP3). Floats above the editor; uses the editor's
 * own selection as the visual highlight so we don't have to mutate the
 * rendered DOM or register a decoration plugin.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import type { Editor } from "@tiptap/react";

import { findMatches, focusMatch, type FindMatch } from "./findInDoc";

type Props = {
  editor: Editor | null;
  /** True when the find bar is mounted; false hides + clears state. */
  open: boolean;
  onClose: () => void;
};

export function FindBar({ editor, open, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const savedSelectionRef = useRef<FindMatch | null>(null);

  // Recompute matches each time the query or editor doc changes. The
  // doc identity changes via Tiptap's transaction stream — keying on
  // editor.state would re-run on every keystroke, which is what we
  // want: a fresh edit moves the matches.
  const matches = useMemo(
    () => findMatches(editor, query.trim()),
    // editor.state intentionally omitted from deps — Tiptap rebinds the
    // same editor reference and we want the latest matches each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor, query],
  );

  // Snapshot the user's selection on open so Esc can restore it.
  useEffect(() => {
    if (!open || !editor) return;
    const { from, to } = editor.state.selection;
    savedSelectionRef.current = { from, to };
    setCursor(0);
    const id = window.requestAnimationFrame(() =>
      inputRef.current?.focus(),
    );
    return () => window.cancelAnimationFrame(id);
  }, [open, editor]);

  // Move the editor selection to the active match whenever it changes.
  useEffect(() => {
    if (!open || matches.length === 0) return;
    const safe = Math.min(cursor, matches.length - 1);
    const m = matches[safe];
    if (m) focusMatch(editor, m);
  }, [open, editor, matches, cursor]);

  // Keep cursor in bounds when the match list shrinks (fresh keystroke
  // returning fewer hits).
  useEffect(() => {
    if (cursor >= matches.length && matches.length > 0) {
      setCursor(matches.length - 1);
    }
  }, [matches.length, cursor]);

  if (!open) return null;

  function next() {
    if (matches.length === 0) return;
    setCursor((c) => (c + 1) % matches.length);
  }
  function prev() {
    if (matches.length === 0) return;
    setCursor((c) => (c - 1 + matches.length) % matches.length);
  }

  function onKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) prev();
      else next();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      // Restore the original selection so closing find doesn't strand
      // the user at the last match.
      const saved = savedSelectionRef.current;
      if (editor && saved) {
        editor
          .chain()
          .focus()
          .setTextSelection({ from: saved.from, to: saved.to })
          .run();
      }
      onClose();
    }
  }

  const total = matches.length;
  const indexLabel =
    total === 0 && query.trim().length > 0
      ? "0 of 0"
      : total === 0
        ? ""
        : `${Math.min(cursor + 1, total)} of ${total}`;

  return (
    <div className="cos-findbar" role="search" onKeyDown={onKey}>
      <input
        ref={inputRef}
        type="text"
        className="cos-findbar-input"
        placeholder="Find in doc"
        aria-label="Find in document"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setCursor(0);
        }}
      />
      {indexLabel && (
        <span className="cos-findbar-count" aria-live="polite">
          {indexLabel}
        </span>
      )}
      <button
        type="button"
        className="cos-findbar-btn"
        onClick={prev}
        disabled={total === 0}
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
      >
        <ChevronUp size={14} strokeWidth={1.75} aria-hidden />
      </button>
      <button
        type="button"
        className="cos-findbar-btn"
        onClick={next}
        disabled={total === 0}
        aria-label="Next match"
        title="Next match (Enter)"
      >
        <ChevronDown size={14} strokeWidth={1.75} aria-hidden />
      </button>
      <button
        type="button"
        className="cos-findbar-btn"
        onClick={() => {
          const saved = savedSelectionRef.current;
          if (editor && saved) {
            editor
              .chain()
              .focus()
              .setTextSelection({ from: saved.from, to: saved.to })
              .run();
          }
          onClose();
        }}
        aria-label="Close find"
        title="Close (Esc)"
      >
        <X size={14} strokeWidth={1.75} aria-hidden />
      </button>
    </div>
  );
}
