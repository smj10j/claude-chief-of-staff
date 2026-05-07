import {
  Home,
  Users,
  CalendarDays,
  CalendarClock,
  Briefcase,
  FolderKanban,
  Activity,
  Terminal,
  Settings as SettingsIcon,
  type LucideIcon,
} from "lucide-react";

export type SurfaceId =
  | "home"
  | "calendar"
  | "people"
  | "meetings"
  | "work"
  | "projects"
  | "ops"
  | "console"
  | "settings";

export type Surface = {
  id: SurfaceId;
  label: string;
  icon: LucideIcon;
  /** Cmd+N shortcut index (1-based). PRD-100 §6.1 reserves 7-9 for future. */
  index: number;
  /** Short description shown in the command palette. */
  description: string;
  /** PRD-116 — surfaces marked "developer" hide unless the user opted
   *  in via Settings → Appearance → "show developer surfaces". They
   *  remain mounted in the router so deep-linking still works. */
  developer?: boolean;
};

export const SURFACES: readonly Surface[] = [
  {
    id: "home",
    label: "Home",
    icon: Home,
    index: 1,
    description: "Today's calendar, attention, and signals",
  },
  {
    id: "calendar",
    label: "Calendar",
    icon: CalendarClock,
    index: 2,
    description: "Today + the week ahead, with prep links",
  },
  {
    id: "people",
    label: "People",
    icon: Users,
    index: 3,
    description: "Org tree, 1:1 sessions, career, calibration",
  },
  {
    id: "meetings",
    label: "Recurring Meetings",
    icon: CalendarDays,
    index: 4,
    description: "Recurring meetings and forums",
  },
  {
    id: "work",
    label: "Tasks",
    icon: Briefcase,
    index: 5,
    description: "What's on you now, bucketed by time",
  },
  {
    id: "projects",
    label: "Projects",
    icon: FolderKanban,
    index: 6,
    description: "Active and archived projects, grouped by status",
  },
  {
    id: "ops",
    label: "Ops",
    icon: Activity,
    index: 7,
    description: "Automation, service health, metrics",
  },
  {
    id: "console",
    label: "Console",
    icon: Terminal,
    // PRD-116 §4.2 — placed between Ops and Settings, hidden behind
    // the Appearance toggle by default. Index 9 keeps Settings on
    // its existing ⌘⌥8 muscle memory.
    index: 9,
    description: "Direct Claude Code session — escape valve for the long tail",
    developer: true,
  },
  {
    id: "settings",
    label: "Settings",
    icon: SettingsIcon,
    index: 8,
    description: "Themes, accounts, plugins, data export",
  },
];

export function findSurface(id: SurfaceId): Surface {
  const s = SURFACES.find((x) => x.id === id);
  if (!s) throw new Error(`unknown surface: ${id}`);
  return s;
}
