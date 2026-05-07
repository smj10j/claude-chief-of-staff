/**
 * Keyboard shortcut cheatsheet (CP8 / Cmd+/).
 *
 * Floating modal listing every global + editor shortcut so the user
 * doesn't have to remember the chord set or hunt through the docs.
 * Esc or Cmd+/ closes; clicking the scrim also closes. Pure UI — the
 * matchGlobalKey function in state/keys.ts is the source of truth for
 * what these chords actually do; this list is curated to mirror it.
 */

import { useEffect } from "react";
import { X } from "lucide-react";

type Section = {
  label: string;
  rows: { keys: string; action: string }[];
};

const SECTIONS: Section[] = [
  {
    label: "Tabs",
    rows: [
      { keys: "⌘T", action: "New tab" },
      { keys: "⌘W", action: "Close current tab" },
      { keys: "⌘⇧T", action: "Reopen last closed tab (10-deep)" },
      { keys: "⌘1 – ⌘8", action: "Switch to tab N" },
      { keys: "⌘9", action: "Switch to rightmost tab" },
      { keys: "⌘⇧]", action: "Next tab" },
      { keys: "⌘⇧[", action: "Previous tab" },
      { keys: "F2", action: "Rename current tab (Esc cancels, empty resets to auto)" },
      { keys: "⌘⇧L", action: "Pin / unpin current tab" },
      { keys: "Right-click", action: "Open tab actions menu" },
      { keys: "Double-click", action: "Rename tab" },
      { keys: "⌘-click", action: "Open in new background tab" },
      { keys: "⌘⇧-click", action: "Open in new tab and switch to it" },
      { keys: "Middle-click", action: "Open in new background tab / close tab" },
      { keys: "⌘K → tab:", action: "Search open tabs only" },
    ],
  },
  {
    label: "Navigation",
    rows: [
      { keys: "⌘K · ⌘P", action: "Open command palette" },
      { keys: "⌘N", action: "Quick-capture a task" },
      { keys: "⌘⌥1 – ⌘⌥8", action: "Jump to surface (Home, Calendar, …)" },
      { keys: "⌘⇧B", action: "Toggle sidebar" },
      { keys: "⌘\\", action: "Toggle side panel" },
      { keys: "⌘/", action: "Show this shortcut sheet" },
      { keys: "Esc", action: "Close doc / palette / modal / find" },
    ],
  },
  {
    label: "Editor",
    rows: [
      { keys: "⌘S", action: "Save now (autosave runs every 2 s)" },
      { keys: "⌘F", action: "Find in document" },
      { keys: "⌘.", action: "Toggle focus mode (hide chrome)" },
      { keys: "⌘⇧O", action: "Toggle outline panel" },
      { keys: "⌘B", action: "Bold" },
      { keys: "⌘I", action: "Italic" },
      { keys: "⌘K", action: "Edit / insert link (when selection)" },
      { keys: "Enter", action: "Find: next match" },
      { keys: "⇧Enter", action: "Find: previous match" },
    ],
  },
  {
    label: "Tasks",
    rows: [
      { keys: "Click checkbox", action: "Complete task (with undo toast)" },
      { keys: "Click row", action: "Open task in side panel" },
      { keys: "⌘N", action: "Quick capture (anywhere in the app)" },
    ],
  },
  {
    label: "Velocity / Ops",
    rows: [
      { keys: "[ / ]", action: "Cycle sub-tabs on Work + Ops" },
      { keys: "⌘K → 'Go to PRs'", action: "Jump to PR queue" },
      { keys: "⌘K → 'Go to Review'", action: "Jump to review queue" },
      { keys: "⌘K → 'Go to my Jira'", action: "Jump to my Jira issues" },
      { keys: "⌘K → 'Go to Incidents'", action: "Jump to active incidents" },
      { keys: "⌘K → 'Go to On-call'", action: "Jump to PagerDuty on-call (B9-CP5)" },
      { keys: "⌘K → 'Go to Roadmap'", action: "Jump to team roadmap" },
      { keys: "⌘K → 'Run morning sweep'", action: "Refresh every Ops + Velocity + Roadmap snapshot" },
    ],
  },
];

export function ShortcutsModal({ onClose }: { onClose: () => void }) {
  // Esc closes — separate from the global handler so the modal stays
  // self-contained and can be dropped anywhere.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div
      className="cos-shortcuts-scrim"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cos-shortcuts">
        <header className="cos-shortcuts-head">
          <h2>Keyboard shortcuts</h2>
          <button
            type="button"
            className="cos-shortcuts-close"
            onClick={onClose}
            aria-label="Close shortcuts"
            title="Close (Esc)"
          >
            <X size={16} strokeWidth={1.75} aria-hidden />
          </button>
        </header>
        <div className="cos-shortcuts-body">
          {SECTIONS.map((section) => (
            <section key={section.label} className="cos-shortcuts-section">
              <h3 className="cos-shortcuts-section-head">{section.label}</h3>
              <ul className="cos-shortcuts-list">
                {section.rows.map((row) => (
                  <li key={row.keys + row.action} className="cos-shortcuts-row">
                    <kbd className="cos-shortcuts-keys">{row.keys}</kbd>
                    <span className="cos-shortcuts-action">{row.action}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
