import { SURFACES, type SurfaceId } from "../state/surfaces";

/**
 * Deterministic command palette ranking per PRD-100 §4.3.
 * Phase-0 subset: exact-prefix > label-substring > recent boost. Full
 * spec (content match, verb-first commands) lands with real data sources.
 */

export type PaletteEntry = {
  id: string;
  kind:
    | "view"
    | "command"
    | "doc"
    | "task"
    | "person"
    | "meeting"
    | "project"
    | "tab";
  label: string;
  hint?: string;
  /** The action performed when selected. */
  run: (ctx: PaletteContext) => void;
  /** Used to show a keyboard shortcut in the list. */
  shortcut?: string;
  /** Pre-baked score for content-search hits — bypasses the substring-
   * scoring path in `rank` since the backend already counted hits. */
  searchScore?: number;
  /** PRD-v2-117 §4.9 / criterion #15: the small "Tab N" chip
   *  shown next to entries that switch to an open tab. Index is
   *  1-based to match the user-visible Cmd+1..9 convention. */
  tabIndex?: number;
};

export type EntityTarget = {
  slug: string;
  label: string;
  rel_path: string;
};

export type PaletteContext = {
  setSurface: (id: SurfaceId) => void;
  toggleSidebar: () => void;
  toggleSidePanel: () => void;
  openDoc: (relPath: string, label: string) => void;
  /** Jump to Work surface with the given task selected. Used by task
   * entries surfaced from v1 SQLite. */
  goToTask: (taskId: string) => void;
  /** Jump to a person profile from the palette (CP2). */
  goToProfile: (target: EntityTarget) => void;
  /** Jump to a recurring meeting from the palette (CP2). */
  goToMeeting: (target: EntityTarget) => void;
  /** Jump to a project from the palette (CP2). */
  goToProject: (target: EntityTarget) => void;
  /** PRD-v2-117 §4.9 / criterion #15: switch to an existing tab
   *  by id. Used by the "Open tabs" section + the "Switch to Tab N"
   *  chip on doc results that match an already-open target. */
  switchToTab: (tabId: string) => void;
};

export function buildEntries(ctx: PaletteContext): PaletteEntry[] {
  const surfaceEntries: PaletteEntry[] = SURFACES.map((s) => ({
    id: `view:${s.id}`,
    kind: "view",
    label: s.label,
    hint: s.description,
    shortcut: `⌘${s.index}`,
    run: () => ctx.setSurface(s.id),
  }));

  const commandEntries: PaletteEntry[] = [
    {
      id: "cmd:toggle-sidebar",
      kind: "command",
      label: "Toggle sidebar",
      shortcut: "⌘⇧B",
      run: () => ctx.toggleSidebar(),
    },
    {
      id: "cmd:toggle-side-panel",
      kind: "command",
      label: "Toggle side panel",
      shortcut: "⌘\\",
      run: () => ctx.toggleSidePanel(),
    },
    // B8-CP32 — tab-jumps. Each entry seeds the surface's
    // sessionStorage tab key before navigating so the right tab is
    // active on mount.
    ...velocityTabJumps(ctx),
    ...opsTabJumps(ctx),
    ...projectsTabJumps(ctx),
  ];

  return [...surfaceEntries, ...commandEntries];
}

function velocityTabJumps(ctx: PaletteContext): PaletteEntry[] {
  const setTab = (tab: "tasks" | "prs" | "review" | "jira") => () => {
    sessionStorage.setItem("cos:work-tab", tab);
    ctx.setSurface("work");
  };
  return [
    { id: "cmd:work:prs", kind: "command", label: "Go to PRs", run: setTab("prs") },
    { id: "cmd:work:review", kind: "command", label: "Go to Review queue", run: setTab("review") },
    { id: "cmd:work:jira", kind: "command", label: "Go to my Jira", run: setTab("jira") },
  ];
}

function opsTabJumps(ctx: PaletteContext): PaletteEntry[] {
  const setTab = (tab: "health" | "incidents" | "oncall") => () => {
    sessionStorage.setItem("cos:ops-tab", tab);
    ctx.setSurface("ops");
  };
  return [
    { id: "cmd:ops:health", kind: "command", label: "Go to Ops Health", run: setTab("health") },
    { id: "cmd:ops:incidents", kind: "command", label: "Go to active Incidents", run: setTab("incidents") },
    { id: "cmd:ops:oncall", kind: "command", label: "Go to On-call (PagerDuty)", run: setTab("oncall") },
    {
      id: "cmd:morning-sweep",
      kind: "command",
      label: "Run morning sweep",
      run: () => {
        window.dispatchEvent(new CustomEvent("cos:morning-sweep"));
      },
    },
  ];
}

function projectsTabJumps(ctx: PaletteContext): PaletteEntry[] {
  const setTab = (tab: "active" | "roadmap") => () => {
    sessionStorage.setItem("cos:projects-tab", tab);
    ctx.setSurface("projects");
  };
  return [
    { id: "cmd:projects:roadmap", kind: "command", label: "Go to team Roadmap", run: setTab("roadmap") },
  ];
}

export type Ranked = {
  entry: PaletteEntry;
  score: number;
};

/**
 * Score in tiers so recent-boost can't outrank an exact prefix of something else
 * (PRD-100 §4.3 rule 4).
 */
export function rank(
  entries: readonly PaletteEntry[],
  query: string,
  recentIds: readonly string[],
): Ranked[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    // Empty query: show open tabs first (already recency-sorted by
    // the caller), then views + commands (recents first, then
    // alphabetical), followed by any doc entries the caller
    // pre-supplied. Tasks stay hidden until typing — they're noisy
    // without a search term.
    const tabs = entries.filter((e) => e.kind === "tab");
    const visible = entries.filter(
      (e) => e.kind === "view" || e.kind === "command",
    );
    const recentSet = new Set(recentIds);
    const recents = visible
      .filter((e) => recentSet.has(e.id))
      .sort((a, b) => recentIds.indexOf(a.id) - recentIds.indexOf(b.id));
    const rest = visible
      .filter((e) => !recentSet.has(e.id))
      .sort((a, b) => a.id.localeCompare(b.id));
    const docs = entries.filter((e) => e.kind === "doc");
    return [...tabs, ...recents, ...rest, ...docs].map((e, i) => ({
      entry: e,
      score: 1000 - i,
    }));
  }

  const ranked: Ranked[] = [];
  for (const entry of entries) {
    // Doc entries from content search came pre-scored; trust them and
    // fold into the same ranked list at a tier below view/command
    // exact-prefix matches but above plain-substring hits.
    if (entry.kind === "doc") {
      ranked.push({ entry, score: entry.searchScore ?? 50 });
      continue;
    }
    const label = entry.label.toLowerCase();
    let base = 0;
    if (label === q) base = 100;
    else if (label.startsWith(q)) base = 90;
    else if (label.includes(` ${q}`)) base = 75;
    else if (label.includes(q)) base = 60;
    else if (entry.hint && entry.hint.toLowerCase().includes(q)) base = 40;

    if (base === 0) continue;

    // Recent boost: +10, capped so a recent substring match still loses to a
    // non-recent exact prefix of something else.
    if (recentIds.includes(entry.id) && base < 95) {
      base += 10;
    }

    ranked.push({ entry, score: base });
  }

  // Deterministic tiebreaker: alphabetical on canonical ID.
  ranked.sort((a, b) =>
    b.score - a.score || a.entry.id.localeCompare(b.entry.id),
  );
  return ranked;
}
