import { useEffect, useRef, useState } from "react";

import { createTaskFromText } from "../state/createTask";
import { type V1Task } from "../surfaces/Work";

type Props = {
  open: boolean;
  onDismiss: () => void;
  onCreated: (task: V1Task) => void;
};

/**
 * Quick due-date presets. Clicking a chip appends the preset phrase
 * to the title — Claude's parse already understands these natively
 * so no extra IPC plumbing is needed. Strips a previously-appended
 * preset before adding a new one so the user can change their mind.
 */
const DUE_PRESETS: { label: string; append: string }[] = [
  { label: "today", append: "due today" },
  { label: "tomorrow", append: "due tomorrow" },
  { label: "next week", append: "due next week" },
  { label: "no date", append: "" },
];

const DUE_HINT_RE = /\s*(?:due (?:today|tomorrow|next week))$/i;

function appendDueHint(current: string, append: string): string {
  // Drop a previously-appended preset so chips don't stack up.
  const trimmed = current.replace(DUE_HINT_RE, "").trimEnd();
  if (append === "") return trimmed;
  return `${trimmed} ${append}`.trim();
}

/**
 * Global task capture modal. Bound to Cmd+N from useGlobalKeys. Lets
 * the user drop in a free-form task ("call bob tomorrow at 2pm
 * about the budget") without leaving the current surface — same
 * Claude-parse-then-create flow the Work inline row uses.
 *
 * Three keyboard paths:
 *   - Enter         → create, with Claude parse
 *   - Shift+Enter   → create, raw title only (skip parse)
 *   - Escape        → dismiss
 *
 * Submission shows a brief in-flight state; on success the modal
 * closes and `onCreated` fires so callers can route to Work or just
 * flash a confirmation.
 */
export function QuickCapture({ open, onDismiss, onCreated }: Props) {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parseFailedNote, setParseFailedNote] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset + focus on open. The rAF wraps the focus call so the modal
  // is in the DOM by the time we focus — focusing a hidden node is a
  // no-op and the user winds up typing into whatever was focused
  // before.
  useEffect(() => {
    if (!open) return;
    setText("");
    setError(null);
    setParseFailedNote(false);
    setSubmitting(false);
    const id = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  if (!open) return null;

  const submit = async (parseWithClaude: boolean) => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    setParseFailedNote(false);
    const result = await createTaskFromText(text, parseWithClaude);
    setSubmitting(false);
    if (result.error || !result.task) {
      setError(result.error ?? "task creation failed");
      return;
    }
    if (result.parseFailed) {
      setParseFailedNote(true);
    }
    onCreated(result.task);
    onDismiss();
  };

  return (
    <div
      className="cos-quickcapture-scrim"
      role="dialog"
      aria-modal="true"
      aria-label="Quick capture task"
      onClick={(e) => {
        if (e.target === e.currentTarget) onDismiss();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onDismiss();
        }
      }}
    >
      <div className="cos-quickcapture">
        <input
          ref={inputRef}
          type="text"
          className="cos-quickcapture-input"
          placeholder="New task — “call bob tomorrow 2pm about budget”"
          value={text}
          disabled={submitting}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit(!e.shiftKey);
            }
          }}
        />
        <div className="cos-quickcapture-due-chips" aria-label="Quick due">
          {DUE_PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              className="cos-quickcapture-due-chip"
              onClick={() => {
                inputRef.current?.focus();
                setText((cur) => appendDueHint(cur, preset.append));
              }}
              disabled={submitting}
              title={`Append "${preset.append}" to the title — Claude parses it as a due-date`}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <div className="cos-quickcapture-meta">
          {submitting ? (
            <span className="cos-quickcapture-status">creating…</span>
          ) : (
            <span className="cos-quickcapture-hint">
              <kbd>Enter</kbd> save · <kbd>Shift</kbd>+<kbd>Enter</kbd> raw ·{" "}
              <kbd>Esc</kbd> close
            </span>
          )}
          {error && (
            <span className="cos-quickcapture-error">{error}</span>
          )}
          {parseFailedNote && !error && (
            <span className="cos-quickcapture-warn">
              parse failed — saved with raw title
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
