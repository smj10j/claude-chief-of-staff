/**
 * PRD-v2-117 §4.5 — one-time "Restore tabs from last session?" sheet
 * shown when the previous launch terminated abnormally (the
 * `cleanQuit` marker on the persisted blob is absent or false).
 *
 * Choices:
 *   - Restore: rehydrate the saved tab strip
 *   - Start with Home: keep an empty Home tab and snapshot the
 *     previous blob to `cos.tabs.v1.crash-snapshot` for manual
 *     recovery (PRD §4.5)
 */

import { useEffect } from "react";

export type CrashRecoveryPromptProps = {
  /** Number of tabs that would be restored — used in the headline so
   *  the user can decide on intent without opening the sheet. */
  tabCount: number;
  onRestore: () => void;
  onStartFresh: () => void;
};

export function CrashRecoveryPrompt({
  tabCount,
  onRestore,
  onStartFresh,
}: CrashRecoveryPromptProps) {
  // Esc dismisses as "start fresh" — the safe default.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onStartFresh();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onStartFresh]);

  return (
    <div
      className="cos-crash-recovery-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cos-crash-recovery-head"
      onClick={(e) => {
        // Clicking the scrim picks "Start fresh" — same as Esc.
        if (e.target === e.currentTarget) onStartFresh();
      }}
    >
      <div className="cos-crash-recovery">
        <h2 id="cos-crash-recovery-head" className="cos-crash-recovery-head">
          Restore tabs from last session?
        </h2>
        <p className="cos-crash-recovery-body">
          Chief of Staff didn't shut down cleanly last time.
          {tabCount > 1
            ? ` You had ${tabCount} tabs open.`
            : " You had 1 tab open."}
        </p>
        <div className="cos-crash-recovery-actions">
          <button type="button" className="cos-btn" onClick={onStartFresh}>
            Start with Home
          </button>
          <button
            type="button"
            className="cos-btn cos-btn-primary"
            onClick={onRestore}
            autoFocus
          >
            Restore
          </button>
        </div>
      </div>
    </div>
  );
}
