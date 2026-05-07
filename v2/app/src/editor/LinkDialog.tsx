import { useEffect, useRef, useState } from "react";

export type LinkDialogMode = "create" | "edit";

export type LinkDialogState =
  | { open: false }
  | {
      open: true;
      mode: LinkDialogMode;
      /** Existing href when editing, empty when creating. */
      initialHref: string;
      /** Existing display text when editing, empty otherwise. */
      initialText: string;
      /** Whether to allow editing the display text — false when the
       *  caller has a non-empty selection that already has the desired
       *  text, so we only need a URL field. */
      allowEditText: boolean;
    };

type Props = {
  state: LinkDialogState;
  onCommit: (result: { href: string; text: string | null }) => void;
  onRemove: () => void;
  onCancel: () => void;
};

/**
 * Modal dialog for creating or editing a link mark in the editor.
 * Replaces the previous `window.prompt`-based flow which is unreliable
 * inside Tauri's webview and didn't expose the existing URL when
 * editing a link.
 *
 * Three modes the caller drives:
 *   - Create with selection: only URL field shown; commit applies the
 *     link to the selection.
 *   - Create without selection: URL + display-text fields; commit
 *     inserts the text and links it.
 *   - Edit existing link: URL field prefilled; "Remove" button visible.
 */
export function LinkDialog({ state, onCommit, onRemove, onCancel }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [href, setHref] = useState("");
  const [text, setText] = useState("");

  // Re-seed inputs each time the dialog opens. Otherwise a closed
  // dialog's stale state would leak into the next open.
  useEffect(() => {
    if (state.open) {
      setHref(state.initialHref);
      setText(state.initialText);
      // Focus on next paint — the dialog isn't in the DOM until after
      // the open transition.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [state.open]);

  if (!state.open) return null;

  const submit = () => {
    const trimmedHref = href.trim();
    if (!trimmedHref) return;
    onCommit({
      href: trimmedHref,
      text: state.allowEditText ? text.trim() || trimmedHref : null,
    });
  };

  return (
    <div
      className="cos-link-dialog-scrim"
      role="dialog"
      aria-modal="true"
      aria-label={state.mode === "edit" ? "Edit link" : "Insert link"}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="cos-link-dialog">
        <div className="cos-link-dialog-head">
          <span className="cos-link-dialog-title">
            {state.mode === "edit" ? "Edit link" : "Insert link"}
          </span>
        </div>
        <div className="cos-link-dialog-body">
          <label className="cos-link-dialog-field">
            <span className="cos-link-dialog-label">URL</span>
            <input
              ref={inputRef}
              type="url"
              className="cos-link-dialog-input"
              placeholder="https://example.com or path/to/file.md"
              value={href}
              onChange={(e) => setHref(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          </label>
          {state.allowEditText && (
            <label className="cos-link-dialog-field">
              <span className="cos-link-dialog-label">Text</span>
              <input
                type="text"
                className="cos-link-dialog-input"
                placeholder="(defaults to the URL)"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submit();
                  }
                }}
              />
            </label>
          )}
        </div>
        <div className="cos-link-dialog-actions">
          {state.mode === "edit" && (
            <button
              type="button"
              className="cos-btn cos-btn-ghost cos-link-dialog-remove"
              onClick={onRemove}
            >
              Remove link
            </button>
          )}
          <span className="cos-link-dialog-spacer" />
          <button
            type="button"
            className="cos-btn cos-btn-ghost"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="cos-btn"
            onClick={submit}
            disabled={href.trim() === ""}
          >
            {state.mode === "edit" ? "Apply" : "Insert"}
          </button>
        </div>
      </div>
    </div>
  );
}
