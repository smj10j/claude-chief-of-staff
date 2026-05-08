/**
 * Soft "Update ready" banner (PRD-103 Phase 1B).
 *
 * Lives at the bottom-right of the shell, above the toast region.
 * Renders only when there's an update worth surfacing — `available`
 * (offer to download), `downloading` (progress), `ready` (offer to
 * restart), or `error` (the auto-installer rejected the update).
 *
 * Urgent updates render with a stronger treatment but still don't
 * force-quit the app — they just narrow the user's choices to
 * "Restart in 60s" or "Dismiss this time."
 */

import { useEffect, useState } from "react";

import {
  downloadAvailableUpdate,
  relaunchToInstall,
  useUpdateState,
} from "../state/updater";

const URGENT_COUNTDOWN_SECS = 60;

export function UpdateBanner() {
  const state = useUpdateState();
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);

  // Urgent-update countdown (PRD §1B: 60s prompt, never force-quit).
  useEffect(() => {
    if (state.kind !== "ready" || !state.urgent) {
      setCountdown(null);
      return;
    }
    if (dismissedVersion === state.version) return;
    setCountdown(URGENT_COUNTDOWN_SECS);
    const id = window.setInterval(() => {
      setCountdown((prev) => (prev === null ? null : prev - 1));
    }, 1000);
    return () => window.clearInterval(id);
  }, [state, dismissedVersion]);

  // Auto-relaunch when the urgent countdown hits zero.
  useEffect(() => {
    if (countdown !== null && countdown <= 0) {
      void relaunchToInstall();
    }
  }, [countdown]);

  // Filter states that shouldn't render the banner.
  if (
    state.kind === "idle" ||
    state.kind === "checking" ||
    state.kind === "uptodate" ||
    state.kind === "installing"
  ) {
    return null;
  }
  if (state.kind === "error" || state.kind === "unconfigured") {
    // Errors from the auto-check are quiet — surface them in
    // Settings only, not in a global banner. We only render the
    // banner for errors when the user explicitly asked (Settings'
    // "Check now" sets a non-silent error). `unconfigured` is the
    // freshly-forked-install case and is even quieter.
    return null;
  }
  if (state.kind === "available" && dismissedVersion === state.version) {
    return null;
  }
  if (state.kind === "ready" && dismissedVersion === state.version) {
    return null;
  }

  const urgentClass =
    (state.kind === "ready" || state.kind === "available") && state.urgent
      ? "is-urgent"
      : "";

  return (
    <div
      className={`cos-update-banner ${urgentClass}`}
      role="status"
      aria-live="polite"
    >
      {state.kind === "available" && (
        <>
          <p className="cos-update-banner-headline">
            {state.urgent
              ? `Important update available — v${state.version}`
              : `Update available — v${state.version}`}
          </p>
          <p className="cos-update-banner-body">
            {state.notes
              ? state.notes.replace(/^urgent:\s*/i, "").slice(0, 240)
              : "Bug fixes and improvements."}
          </p>
          <div className="cos-update-banner-actions">
            <button
              type="button"
              className="cos-btn cos-btn-ghost"
              onClick={() => setDismissedVersion(state.version)}
            >
              not now
            </button>
            <button
              type="button"
              className="cos-btn cos-btn-primary"
              onClick={() => downloadAvailableUpdate()}
            >
              download
            </button>
          </div>
        </>
      )}
      {state.kind === "downloading" && (
        <>
          <p className="cos-update-banner-headline">
            Downloading v{state.version}…
          </p>
          {state.bytesTotal !== null && (
            <progress
              className="cos-update-banner-progress"
              value={state.bytesDone}
              max={state.bytesTotal}
              aria-label="Update download progress"
            />
          )}
          <p className="cos-update-banner-body">
            {state.bytesTotal !== null
              ? `${formatBytes(state.bytesDone)} of ${formatBytes(state.bytesTotal)}`
              : `${formatBytes(state.bytesDone)} so far…`}
          </p>
        </>
      )}
      {state.kind === "ready" && (
        <>
          <p className="cos-update-banner-headline">
            {state.urgent && countdown !== null && countdown > 0
              ? `Restart in ${countdown}s — important update v${state.version}`
              : `Update ready — restart to apply v${state.version}`}
          </p>
          <p className="cos-update-banner-body">
            {state.urgent
              ? "This update fixes an issue we want you on right away. Auto-restart in a minute, or restart now."
              : "Saved your work? You can restart now or wait until your next quit."}
          </p>
          <div className="cos-update-banner-actions">
            <button
              type="button"
              className="cos-btn cos-btn-ghost"
              onClick={() => setDismissedVersion(state.version)}
            >
              {state.urgent ? "dismiss this time" : "later"}
            </button>
            <button
              type="button"
              className="cos-btn cos-btn-primary"
              onClick={() => relaunchToInstall()}
            >
              restart now
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
