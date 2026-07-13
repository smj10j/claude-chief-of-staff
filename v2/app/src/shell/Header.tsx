import {
  Plus,
  Search,
  PanelRight,
  ChevronRight,
  ChevronLeft,
} from "lucide-react";

import { type OpenDoc } from "../state/openDoc";
import { useRunning } from "../state/skillRuns";
import { findSurface, type SurfaceId } from "../state/surfaces";
import { intentFromEvent, type OpenIntent } from "../state/tabs";
import { type MeetingTarget } from "../surfaces/MeetingDetail";
import { type ProfileTarget } from "../surfaces/PersonProfile";
import { type ProjectTarget } from "../surfaces/ProjectDetail";

type Props = {
  active: SurfaceId;
  openDoc: OpenDoc | null;
  peopleProfile: ProfileTarget | null;
  projectProfile: ProjectTarget | null;
  meetingProfile: MeetingTarget | null;
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
  onOpenPalette: () => void;
  onOpenQuickCapture: () => void;
  onToggleSide: () => void;
  onPopDoc: () => void;
  onClearProfile: () => void;
  onClearProject: () => void;
  onClearMeeting: () => void;
};

export function Header({
  active,
  openDoc,
  peopleProfile,
  projectProfile,
  meetingProfile,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
  onOpenPalette,
  onOpenQuickCapture,
  onToggleSide,
  onPopDoc,
  onClearProfile,
  onClearProject,
  onClearMeeting,
}: Props) {
  const surface = findSurface(active);

  // The "active" detail context — at most one of people/project/meeting
  // profile is set at a time. Used both to render a `Surface > <Detail>`
  // crumb chain when no doc is open and to decide what clicking the
  // surface crumb should clear (each *Profile clear() also nukes
  // openDoc, so navigating up to the surface always lands cleanly).
  const detailLabel =
    peopleProfile?.label ??
    projectProfile?.label ??
    meetingProfile?.label ??
    null;

  const onSurfaceCrumb = () => {
    if (peopleProfile) onClearProfile();
    else if (projectProfile) onClearProject();
    else if (meetingProfile) onClearMeeting();
    else onPopDoc();
  };

  const goToProfile = (target: ProfileTarget, intent: OpenIntent) => {
    window.dispatchEvent(
      new CustomEvent("cos:goto", { detail: { profile: target, intent } }),
    );
  };
  const goToProject = (
    target: { slug: string; label: string; rel_path: string },
    intent: OpenIntent,
  ) => {
    window.dispatchEvent(
      new CustomEvent("cos:goto", { detail: { project: target, intent } }),
    );
  };
  const goToMeeting = (
    target: { slug: string; label: string; rel_path: string },
    intent: OpenIntent,
  ) => {
    window.dispatchEvent(
      new CustomEvent("cos:goto", { detail: { meeting: target, intent } }),
    );
  };
  const followCrumb = (
    c: NonNullable<OpenDoc["crumbs"]>[number],
    intent: OpenIntent,
  ) => {
    if (c.profile) goToProfile(c.profile, intent);
    else if (c.project) goToProject(c.project, intent);
    else if (c.meeting) goToMeeting(c.meeting, intent);
    else onPopDoc();
  };
  // On a bare surface the breadcrumb only repeats what the sidebar +
  // hero already say. Render it only when there's a sub-context (an
  // open doc or a detail profile) where it's actually useful as nav.
  const hasSubContext = Boolean(openDoc || detailLabel);

  return (
    <header className="cos-header-bar">
      <div className="cos-header-left">
        <div className="cos-nav-history" role="group" aria-label="Navigation history">
          <button
            type="button"
            className="cos-icon-btn cos-nav-history-btn"
            onClick={onGoBack}
            disabled={!canGoBack}
            aria-label="Back"
            title="Back · ⌘["
          >
            <ChevronLeft size={16} strokeWidth={1.75} aria-hidden />
          </button>
          <button
            type="button"
            className="cos-icon-btn cos-nav-history-btn"
            onClick={onGoForward}
            disabled={!canGoForward}
            aria-label="Forward"
            title="Forward · ⌘]"
          >
            <ChevronRight size={16} strokeWidth={1.75} aria-hidden />
          </button>
        </div>
      {hasSubContext ? (
        <nav className="cos-breadcrumb" aria-label="Breadcrumb">
          {openDoc ? (
            <>
              <button
                type="button"
                className="cos-breadcrumb-parent cos-breadcrumb-link"
                onClick={onSurfaceCrumb}
                title={`Back to ${surface.label}`}
              >
                {surface.label}
              </button>
              {(openDoc.crumbs ?? []).map((c, i) => (
                <span key={i} className="cos-breadcrumb-crumb">
                  <ChevronRight
                    size={12}
                    strokeWidth={1.75}
                    aria-hidden
                    className="cos-breadcrumb-sep"
                  />
                  <button
                    type="button"
                    className="cos-breadcrumb-parent cos-breadcrumb-link"
                    onClick={(e) => followCrumb(c, intentFromEvent(e))}
                    onAuxClick={(e) => {
                      if (e.button === 1) followCrumb(c, intentFromEvent(e));
                    }}
                    title={`Back to ${c.label}`}
                  >
                    {c.label}
                  </button>
                </span>
              ))}
              <ChevronRight
                size={12}
                strokeWidth={1.75}
                aria-hidden
                className="cos-breadcrumb-sep"
              />
              <span className="cos-breadcrumb-current">{openDoc.label}</span>
            </>
          ) : detailLabel ? (
            <>
              <button
                type="button"
                className="cos-breadcrumb-parent cos-breadcrumb-link"
                onClick={onSurfaceCrumb}
                title={`Back to ${surface.label}`}
              >
                {surface.label}
              </button>
              <ChevronRight
                size={12}
                strokeWidth={1.75}
                aria-hidden
                className="cos-breadcrumb-sep"
              />
              <span className="cos-breadcrumb-current">{detailLabel}</span>
            </>
          ) : null}
        </nav>
      ) : null}
      </div>

      <div className="cos-actions">
        <RunningSkillsPill />
        <button
          type="button"
          className="cos-icon-btn"
          onClick={onOpenQuickCapture}
          aria-label="New task"
          title="New task · ⌘N"
        >
          <Plus size={16} strokeWidth={1.75} aria-hidden />
        </button>
        <button
          type="button"
          className="cos-pill"
          onClick={onOpenPalette}
          aria-label="Open command palette"
          title="Command palette · ⌘K"
        >
          <Search size={14} strokeWidth={1.75} aria-hidden />
          <span>Search or run a command</span>
          <kbd className="cos-kbd">⌘K</kbd>
        </button>
        <button
          type="button"
          className="cos-icon-btn"
          onClick={onToggleSide}
          aria-label="Toggle side panel"
          title="Toggle side panel · ⌘\"
        >
          <PanelRight size={16} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
    </header>
  );
}

function RunningSkillsPill() {
  const running = useRunning();
  if (running.length === 0) return null;
  const tooltip = running.map((r) => `• ${r.label}`).join("\n");
  return (
    <span
      className="cos-running-pill"
      role="status"
      aria-live="polite"
      title={tooltip}
    >
      <span className="cos-newtask-spinner" aria-hidden />
      {running.length === 1
        ? running[0]!.label
        : `${running.length} skills running`}
    </span>
  );
}
