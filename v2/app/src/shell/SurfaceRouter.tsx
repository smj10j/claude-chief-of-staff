import { Calendar } from "../surfaces/Calendar";
import { Home } from "../surfaces/Home";
import { Meetings } from "../surfaces/Meetings";
import { type MeetingTarget } from "../surfaces/MeetingDetail";
import { Ops } from "../surfaces/Ops";
import { People } from "../surfaces/People";
import { type ProfileTarget } from "../surfaces/PersonProfile";
import { type ProjectTarget } from "../surfaces/ProjectDetail";
import { Projects } from "../surfaces/Projects";
import { Settings } from "../surfaces/Settings";
import { TaskDetailPanel, Work, type V1Task } from "../surfaces/Work";
import { type OpenDoc } from "../state/openDoc";
import { type SurfaceId } from "../state/surfaces";
import { type OpenIntent } from "../state/tabs";

// NB: the Console surface is not routed here. Shell mounts it
// persistently (kept alive across surface switches) so this router only
// covers the surfaces that are fine to mount/unmount on demand.

type Props = {
  active: SurfaceId;
  selectedTask: V1Task | null;
  onSelectTask: (t: V1Task | null) => void;
  onOpenDoc: (doc: OpenDoc) => void;
  taskRefreshNonce: number;
  peopleProfile: ProfileTarget | null;
  onGoToProfile: (target: ProfileTarget, intent?: OpenIntent) => void;
  onClearProfile: () => void;
  onTaskCreated: (t: V1Task) => void;
  taskScrollHint: { id: string } | null;
  onGoToTask: (id: string) => void;
  projectProfile: ProjectTarget | null;
  onGoToProject: (target: ProjectTarget) => void;
  onClearProject: () => void;
  meetingProfile: MeetingTarget | null;
  onGoToMeeting: (target: MeetingTarget) => void;
  onClearMeeting: () => void;
};

export function SurfaceRouter({
  active,
  selectedTask,
  onSelectTask,
  onOpenDoc,
  taskRefreshNonce,
  peopleProfile,
  onGoToProfile,
  onClearProfile,
  onTaskCreated,
  taskScrollHint,
  onGoToTask,
  projectProfile,
  onGoToProject,
  onClearProject,
  meetingProfile,
  onGoToMeeting,
  onClearMeeting,
}: Props) {
  switch (active) {
    case "home":
      return (
        <Home
          onOpenDoc={onOpenDoc}
          onGoToTask={onGoToTask}
          onGoToMeeting={onGoToMeeting}
          onGoToProfile={onGoToProfile}
        />
      );
    case "people":
      return (
        <People
          onOpenDoc={onOpenDoc}
          profile={peopleProfile}
          onGoToProfile={onGoToProfile}
          onClearProfile={onClearProfile}
        />
      );
    case "calendar":
      return (
        <Calendar
          onOpenDoc={onOpenDoc}
          onGoToMeeting={onGoToMeeting}
          onGoToProfile={onGoToProfile}
        />
      );
    case "meetings":
      return (
        <Meetings
          onOpenDoc={onOpenDoc}
          profile={meetingProfile}
          onGoToMeeting={onGoToMeeting}
          onClearMeeting={onClearMeeting}
        />
      );
    case "work":
      return (
        <Work
          onSelect={onSelectTask}
          selectedId={selectedTask?.id ?? null}
          refreshNonce={taskRefreshNonce}
          onOpenDoc={onOpenDoc}
          onCreated={onTaskCreated}
          scrollHint={taskScrollHint}
        />
      );
    case "projects":
      return (
        <Projects
          onOpenDoc={onOpenDoc}
          profile={projectProfile}
          onGoToProject={onGoToProject}
          onClearProject={onClearProject}
        />
      );
    case "ops":
      return <Ops onGoToProfile={onGoToProfile} />;
    case "console":
      // Mounted persistently by Shell; never routed here.
      return null;
    case "settings":
      return <Settings />;
  }
}

export function SurfaceSidePanel({
  active,
  selectedTask,
  onTaskUpdated,
  onTaskComplete,
}: {
  active: SurfaceId;
  selectedTask: V1Task | null;
  onTaskUpdated: (fresh: V1Task) => void;
  onTaskComplete: (task: V1Task) => void;
}) {
  if (active === "work") {
    return (
      <TaskDetailPanel
        task={selectedTask}
        onUpdated={onTaskUpdated}
        onComplete={onTaskComplete}
      />
    );
  }
  return (
    <div className="cos-side-placeholder">
      <p>Side panel is surface-scoped context.</p>
      <p className="cos-placeholder-muted">
        Plugins mount here via the <code>panel</code> contract (PRD-104). No
        panels registered for this surface yet.
      </p>
    </div>
  );
}
