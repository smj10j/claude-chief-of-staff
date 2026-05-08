import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { type OpenDoc } from "../state/openDoc";
import { SectionHeader, SurfaceHero } from "../ui";
import { ProjectDetail, type ProjectTarget } from "./ProjectDetail";

export type ProjectRef = {
  slug: string;
  label: string;
  rel_path: string;
  has_readme: boolean;
  extra_md_count: number;
  last_touched: string | null;
};

export type ProjectFile = {
  name: string;
  rel_path: string;
};

/** PRD-115 §6.6 — backend feed (B3-CP4). One row per project. */
type ProjectStatus =
  | "on-track"
  | "at-risk"
  | "blocked"
  | "soon-done"
  | "archived";

type ProjectStatusInfo = {
  slug: string;
  status: ProjectStatus;
  /** "explicit" | "derived" — provenance hint for the card. */
  source: string;
  /** Free-text status note from INDEX.md when explicit. */
  note: string | null;
};

type Load =
  | { kind: "loading" }
  | { kind: "ok"; projects: ProjectRef[] }
  | { kind: "error"; error: string };

type Props = {
  onOpenDoc: (doc: OpenDoc) => void;
  /** Mirrors the People surface: when set, render ProjectDetail instead
   *  of the list. Lets Shell hold detail state across nav. */
  profile: ProjectTarget | null;
  onGoToProject: (target: ProjectTarget) => void;
  onClearProject: () => void;
};

const STATUS_ORDER: ProjectStatus[] = [
  "blocked",
  "at-risk",
  "on-track",
  "soon-done",
];

const STATUS_LABELS: Record<ProjectStatus, string> = {
  blocked: "Blocked",
  "at-risk": "At risk",
  "on-track": "On track",
  "soon-done": "Soon done",
  archived: "Archived",
};

/**
 * Project browser — a card per `data/files/projects/<slug>/`. The user
 * has a folder per active initiative; this surface gives them a one-
 * click route to either the README or any sub-doc inside.
 *
 * PRD-115 §6.6: grouped by status (Blocked / At risk / On track / Soon
 * done) using the explicit-then-derived signal from content_project_status
 * (B3-CP4). Within each group, sort by last_touched desc. Archived
 * projects collapse to a strip below the active grid.
 */
export function Projects({
  onOpenDoc,
  profile,
  onGoToProject,
  onClearProject,
}: Props) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [statusMap, setStatusMap] = useState<Map<string, ProjectStatusInfo>>(
    new Map(),
  );
  // B8-CP24 — Active (default) vs. Roadmap (Jira epics for the
  // user's team). Roadmap is a sibling render path that renders an
  // entirely different list, so the existing project-grid logic
  // stays untouched.
  const [tab, setTab] = useState<"active" | "roadmap">(() => {
    const raw = sessionStorage.getItem("cos:projects-tab");
    return raw === "roadmap" ? "roadmap" : "active";
  });
  useEffect(() => {
    sessionStorage.setItem("cos:projects-tab", tab);
  }, [tab]);
  // `pinnedRel` is the project the user explicitly pinned via the
  // "files" button — survives mouse leave. Hover state lives per-card.
  const [pinnedRel, setPinnedRel] = useState<string | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [search, setSearch] = useState("");

  const todayDate = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const projects = await invoke<ProjectRef[]>(
          "content_list_project_refs",
        );
        if (!cancelled) setLoad({ kind: "ok", projects });
      } catch (error) {
        if (!cancelled) setLoad({ kind: "error", error: String(error) });
      }
      try {
        const statuses = await invoke<ProjectStatusInfo[]>(
          "content_project_status",
          { today: todayDate },
        );
        if (!cancelled) {
          const map = new Map<string, ProjectStatusInfo>();
          for (const s of statuses) map.set(s.slug, s);
          setStatusMap(map);
        }
      } catch {
        // Status feed is enrichment, not load-bearing — fall back to
        // a single "Active" group if it fails.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [todayDate]);

  // Search hits — declared above all early returns so hook order stays
  // stable across the list ↔ detail toggle. `searchActive` is the toggle
  // for the rest of the layout (status grid hides while a query is
  // active).
  const searchActive = search.trim().length > 0;
  const searchHits = useMemo(() => {
    if (!searchActive || load.kind !== "ok") return [] as ProjectRef[];
    const q = search.trim().toLowerCase();
    return load.projects
      .filter(
        (p) =>
          p.label.toLowerCase().includes(q) ||
          p.slug.toLowerCase().includes(q),
      )
      .slice(0, 30);
  }, [search, searchActive, load]);

  // Detail view short-circuits the list, mirroring People → PersonProfile.
  if (profile) {
    return (
      <ProjectDetail
        target={profile}
        onOpenDoc={onOpenDoc}
        onBack={onClearProject}
      />
    );
  }

  if (load.kind === "loading") {
    return <div className="cos-empty">Loading projects…</div>;
  }
  if (load.kind === "error") {
    return (
      <div className="cos-empty cos-empty-error">
        Could not load projects: {load.error}
      </div>
    );
  }
  if (load.projects.length === 0) {
    return (
      <div className="cos-empty">
        <p>No projects yet.</p>
        <p className="cos-empty-hint">
          Create a folder under <code>data/files/projects/&lt;slug&gt;/</code>{" "}
          with a <code>README.md</code>.
        </p>
      </div>
    );
  }

  // Bucket projects by status. Anything not in the status feed
  // (or marked archived) lands in the "active no-status" or
  // "archived" buckets respectively. Within each bucket, sort by
  // last_touched desc so the recently-edited project floats up.
  const grouped = new Map<ProjectStatus, ProjectRef[]>();
  const archived: ProjectRef[] = [];
  const noStatus: ProjectRef[] = [];
  for (const p of load.projects) {
    const info = statusMap.get(p.slug);
    if (info?.status === "archived") {
      archived.push(p);
      continue;
    }
    if (!info) {
      noStatus.push(p);
      continue;
    }
    const bucket = grouped.get(info.status) ?? [];
    bucket.push(p);
    grouped.set(info.status, bucket);
  }
  for (const list of [...grouped.values(), archived, noStatus]) {
    list.sort((a, b) => {
      const at = a.last_touched ?? "";
      const bt = b.last_touched ?? "";
      return bt.localeCompare(at);
    });
  }

  const totalActive =
    load.projects.length - archived.length;

  return (
    <div className="cos-projects">
      <SurfaceHero
        title="Projects"
        subtitle={
          totalActive === 0
            ? "No active projects."
            : `${totalActive} active project${totalActive === 1 ? "" : "s"}.`
        }
      />

      <div className="cos-tabs cos-projects-tabs" role="tablist" aria-label="Projects view">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "active"}
          className={`cos-tab${tab === "active" ? " is-active" : ""}`}
          onClick={() => setTab("active")}
        >
          Active
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "roadmap"}
          className={`cos-tab${tab === "roadmap" ? " is-active" : ""}`}
          onClick={() => setTab("roadmap")}
        >
          Roadmap
        </button>
      </div>

      {tab === "roadmap" && <RoadmapTab />}
      {tab === "active" && <>

      <div className="cos-people-search">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by name…"
          aria-label="Filter projects by name"
          className="cos-people-search-input"
        />
        {searchActive && (
          <button
            type="button"
            className="cos-btn cos-btn-ghost"
            onClick={() => setSearch("")}
          >
            clear
          </button>
        )}
      </div>

      {searchActive && (
        <section
          className="cos-people-search-results"
          aria-label="Search results"
        >
          {searchHits.length === 0 ? (
            <p className="cos-empty">No matches.</p>
          ) : (
            <ul className="cos-people-search-list" role="list">
              {searchHits.map((p) => {
                const status = statusMap.get(p.slug);
                const note =
                  status?.note && status.note.trim().length > 0
                    ? status.note.trim()
                    : null;
                const statusLabel = status
                  ? STATUS_LABELS[status.status]
                  : null;
                const subtitle =
                  note ??
                  statusLabel ??
                  (p.extra_md_count === 0
                    ? "README only"
                    : `${p.extra_md_count} extra ${
                        p.extra_md_count === 1 ? "doc" : "docs"
                      }`);
                return (
                  <li key={p.slug}>
                    <button
                      type="button"
                      className="cos-people-search-row"
                      onClick={() =>
                        onGoToProject({
                          slug: p.slug,
                          label: p.label,
                          rel_path: p.rel_path,
                        })
                      }
                    >
                      {status && (
                        <span
                          className={`cos-project-dot tone-${status.status}`}
                          aria-hidden
                          title={statusLabel ?? ""}
                        />
                      )}
                      <span className="cos-people-search-text">
                        <span className="cos-people-search-name">
                          {p.label}
                        </span>
                        <span className="cos-people-search-sub">
                          {subtitle}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {!searchActive && <div className="cos-projects-grid">
        {STATUS_ORDER.map((status) => {
          const bucket = grouped.get(status);
          if (!bucket || bucket.length === 0) return null;
          return (
            <ProjectColumn
              key={status}
              status={status}
              label={STATUS_LABELS[status]}
              projects={bucket}
              statusMap={statusMap}
              pinnedRel={pinnedRel}
              onTogglePin={(rel) =>
                setPinnedRel((cur) => (cur === rel ? null : rel))
              }
              onGoToProject={onGoToProject}
              onOpenDoc={onOpenDoc}
            />
          );
        })}
        {noStatus.length > 0 && (
          <ProjectColumn
            status={null}
            label="Active"
            projects={noStatus}
            statusMap={statusMap}
            pinnedRel={pinnedRel}
            onTogglePin={(rel) =>
              setPinnedRel((cur) => (cur === rel ? null : rel))
            }
            onGoToProject={onGoToProject}
            onOpenDoc={onOpenDoc}
          />
        )}
      </div>}

      {!searchActive && archived.length > 0 && (
        <section className="cos-projects-archived">
          <SectionHeader
            label="Archived"
            count={archived.length}
            collapsible
            collapsed={!archivedOpen}
            onToggle={() => setArchivedOpen((v) => !v)}
          />
          {archivedOpen && (
            <div className="cos-projects-archived-list">
              {archived.map((p) => (
                <ProjectCard
                  key={p.rel_path}
                  project={p}
                  status={statusMap.get(p.slug) ?? null}
                  pinned={pinnedRel === p.rel_path}
                  onTogglePin={() =>
                    setPinnedRel((cur) =>
                      cur === p.rel_path ? null : p.rel_path,
                    )
                  }
                  onGoToProject={onGoToProject}
                  onOpenDoc={onOpenDoc}
                />
              ))}
            </div>
          )}
        </section>
      )}
      </>}
    </div>
  );
}

function ProjectColumn({
  status,
  label,
  projects,
  statusMap,
  pinnedRel,
  onTogglePin,
  onGoToProject,
  onOpenDoc,
}: {
  status: ProjectStatus | null;
  label: string;
  projects: ProjectRef[];
  statusMap: Map<string, ProjectStatusInfo>;
  pinnedRel: string | null;
  onTogglePin: (relPath: string) => void;
  onGoToProject: (target: ProjectTarget) => void;
  onOpenDoc: (doc: OpenDoc) => void;
}) {
  return (
    <section
      className={`cos-projects-col${status ? ` tone-${status}` : ""}`}
      aria-label={`${label} projects`}
    >
      <SectionHeader label={label} count={projects.length} />
      <div className="cos-projects-col-list">
        {projects.map((p) => (
          <ProjectCard
            key={p.rel_path}
            project={p}
            status={statusMap.get(p.slug) ?? null}
            pinned={pinnedRel === p.rel_path}
            onTogglePin={() => onTogglePin(p.rel_path)}
            onGoToProject={onGoToProject}
            onOpenDoc={onOpenDoc}
          />
        ))}
      </div>
    </section>
  );
}

function ProjectCard({
  project,
  status,
  pinned,
  onTogglePin,
  onGoToProject,
  onOpenDoc,
}: {
  project: ProjectRef;
  status: ProjectStatusInfo | null;
  pinned: boolean;
  onTogglePin: () => void;
  onGoToProject: (target: ProjectTarget) => void;
  onOpenDoc: (doc: OpenDoc) => void;
}) {
  // Hover state lives on the card and tears down on mouse-leave so
  // glancing past doesn't litter the UI with open file lists. Pinned
  // state (set via the explicit "files" button) wins over hover —
  // useful for keyboard / touch / accessibility users who can't rely
  // on hover semantics.
  const [hovered, setHovered] = useState(false);
  // Small open delay keeps the list calm when the user just scrolls
  // through projects with the mouse over them. Close is immediate.
  const openTimerRef = useRef<number | null>(null);
  const HOVER_OPEN_MS = 150;

  useEffect(() => {
    return () => {
      if (openTimerRef.current != null) {
        window.clearTimeout(openTimerRef.current);
      }
    };
  }, []);

  const onMouseEnter = () => {
    if (openTimerRef.current != null) return;
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null;
      setHovered(true);
    }, HOVER_OPEN_MS);
  };
  const onMouseLeave = () => {
    if (openTimerRef.current != null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    setHovered(false);
  };

  // Only auto- or pin-expand when there's actually something beyond
  // the README to list. extra_md_count is "files other than README,"
  // which is exactly the right gate.
  const hasExtras = project.extra_md_count > 0;
  const showFiles = hasExtras && (pinned || hovered);

  const openProject = () => {
    onGoToProject({
      slug: project.slug,
      label: project.label,
      rel_path: project.rel_path,
    });
  };

  // Click anywhere on the card → open the project detail view, except
  // for the file rows (open the file) and the pin button (toggle pin).
  // Inner controls call e.stopPropagation() so this only fires for the
  // card body itself.
  const onCardClick = () => {
    openProject();
  };
  const onCardKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openProject();
    }
  };

  const totalDocs = project.extra_md_count + (project.has_readme ? 1 : 0);
  const docsLabel =
    totalDocs === 0
      ? "no docs"
      : totalDocs === 1
        ? "1 doc"
        : `${totalDocs} docs`;
  const stale = project.last_touched
    ? touchedLabel(project.last_touched)
    : null;

  return (
    <article
      className={`cos-project-card is-clickable${
        showFiles ? " is-open" : ""
      }${pinned ? " is-pinned" : ""}${
        status ? ` tone-${status.status}` : ""
      }`}
      role="button"
      tabIndex={0}
      onClick={onCardClick}
      onKeyDown={onCardKeyDown}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      aria-label={`Open ${project.label}`}
    >
      <div className="cos-project-card-head">
        <div className="cos-project-card-title">
          {status && (
            <span
              className={`cos-project-dot tone-${status.status}`}
              aria-hidden
              title={`${STATUS_LABELS[status.status]} (${status.source})`}
            />
          )}
          <span className="cos-project-label">{project.label}</span>
          {!project.has_readme && (
            <span className="cos-chip cos-chip-muted">no README</span>
          )}
        </div>
        <div className="cos-project-card-meta">
          <span className="cos-project-docs">{docsLabel}</span>
          {stale && (
            <span
              className="cos-project-touched"
              title={project.last_touched ?? ""}
            >
              {stale}
            </span>
          )}
          <button
            type="button"
            className="cos-btn cos-btn-ghost cos-project-toggle"
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin();
            }}
            disabled={!hasExtras}
            aria-expanded={showFiles}
            title={
              !hasExtras
                ? "No files beyond the README"
                : pinned
                  ? "Unpin file list"
                  : "Pin file list open (otherwise auto-collapses on mouse leave)"
            }
          >
            {pinned ? "hide files" : "files"}
          </button>
        </div>
      </div>
      {status?.note && (
        <p className="cos-project-note">{status.note}</p>
      )}
      {showFiles && (
        <ProjectFilesBlock
          relPath={project.rel_path}
          label={project.label}
          onOpenDoc={onOpenDoc}
          projectTarget={{
            slug: project.slug,
            label: project.label,
            rel_path: project.rel_path,
          }}
        />
      )}
    </article>
  );
}

function ProjectFilesBlock({
  relPath,
  label,
  onOpenDoc,
  projectTarget,
}: {
  relPath: string;
  label: string;
  onOpenDoc: (doc: OpenDoc) => void;
  projectTarget: ProjectTarget;
}) {
  const [load, setLoad] = useState<
    | { kind: "loading" }
    | { kind: "ok"; files: ProjectFile[] }
    | { kind: "error"; error: string }
  >({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const files = await invoke<ProjectFile[]>(
          "content_list_project_files",
          { relPath },
        );
        if (!cancelled) setLoad({ kind: "ok", files });
      } catch (error) {
        if (!cancelled) setLoad({ kind: "error", error: String(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [relPath]);

  // Mouse events on the file list shouldn't bubble up to the card-as-
  // button click handler. Wrap the container in a click stopper so any
  // accidental drag / focus dance still doesn't fire openProject.
  const stop = (e: React.MouseEvent | React.KeyboardEvent) =>
    e.stopPropagation();

  if (load.kind === "loading") {
    return (
      <div className="cos-project-files" onClick={stop}>
        Loading…
      </div>
    );
  }
  if (load.kind === "error") {
    return (
      <div className="cos-project-files cos-empty-error" onClick={stop}>
        {load.error}
      </div>
    );
  }
  if (load.files.length === 0) {
    return (
      <div className="cos-project-files cos-empty-hint" onClick={stop}>
        No files yet.
      </div>
    );
  }
  // README is also "in" the project but is the canonical landing doc —
  // handled by the card click itself, no need to list it here too.
  const otherFiles = load.files.filter(
    (f) => !f.rel_path.endsWith("/README.md"),
  );
  if (otherFiles.length === 0) {
    return (
      <div className="cos-project-files cos-empty-hint" onClick={stop}>
        Just a README — open the project to read it.
      </div>
    );
  }
  return (
    <ul className="cos-project-files" role="list" onClick={stop}>
      {otherFiles.map((f) => (
        <li key={f.rel_path}>
          <button
            type="button"
            className="cos-project-files-row"
            onClick={(e) => {
              e.stopPropagation();
              onOpenDoc({
                relPath: f.rel_path,
                label: f.name.replace(/\.(md|html)$/, ""),
                crumbs: [{ label, project: projectTarget }],
              });
            }}
          >
            <span className="cos-project-files-name">
              {f.name.replace(/\.(md|html)$/, "")}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function touchedLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const days = Math.round((now.getTime() - d.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days}d ago`;
  if (days < 60) return `${Math.round(days / 7)}w ago`;
  return `${Math.round(days / 30)}mo ago`;
}

// ============================================================
// B8-CP24 — Roadmap tab. Renders Jira epics for the user's team
// from data/files/areas/planning/epics.json (written by
// /planning-team-epics).
// ============================================================

import { runSkill, useRun } from "../state/skillRuns";
import { showToast } from "../state/toasts";
import { openUrl } from "@tauri-apps/plugin-opener";
import { epicHealth, isEpicStale } from "../state/planning";

export type Epic = {
  key: string;
  title: string;
  status?: string;
  category?: "To Do" | "In Progress" | "Done";
  url?: string;
  owner?: string;
  due?: string | null;
  updated?: string;
  tickets_total?: number;
  tickets_done?: number;
  tickets_blocked?: number;
  labels?: string[];
};

type EpicsPayload = {
  fetched_at: string | null;
  team?: string;
  epics: Epic[];
  missing?: boolean;
  mcp_error?: string;
};

function RoadmapTab() {
  // B9-CP21 — Epics / Discovery sub-tabs. Default Epics; Discovery
  // shows the JPD snapshot.
  const [sub, setSub] = useState<"epics" | "discovery">(() => {
    const raw = sessionStorage.getItem("cos:roadmap-sub");
    return raw === "discovery" ? "discovery" : "epics";
  });
  useEffect(() => {
    sessionStorage.setItem("cos:roadmap-sub", sub);
  }, [sub]);
  if (sub === "discovery") {
    return (
      <DiscoveryTab onSwitch={(next) => setSub(next)} />
    );
  }
  return <EpicsTab onSwitch={(next) => setSub(next)} />;
}

function EpicsTab({
  onSwitch,
}: {
  onSwitch: (next: "epics" | "discovery") => void;
}) {
  const [payload, setPayload] = useState<EpicsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useRun("planning-team-epics");
  const refreshing = run?.state === "running";
  // B9-CP17 — search + health filter.
  const [query, setQuery] = useState("");
  const [healthFilter, setHealthFilter] = useState<
    "all" | "red" | "amber" | "green"
  >("all");
  // B9-CP20 — team scope picker. Source of truth is opsPrefs
  // (Settings → Ops → Service ownership). The user's own team
  // defaults selected if it's listed; otherwise the first team.
  const teamOptions = useMemo(() => {
    try {
      const raw = localStorage.getItem("cos:ops-prefs");
      if (!raw) return [] as string[];
      const parsed = JSON.parse(raw) as {
        myTeam?: string;
        teamServices?: Record<string, string[]>;
      };
      const teams = Object.keys(parsed.teamServices ?? {});
      if (parsed.myTeam && !teams.includes(parsed.myTeam)) teams.unshift(parsed.myTeam);
      return teams;
    } catch {
      return [];
    }
  }, []);
  const [team, setTeam] = useState<string>(() => {
    return teamOptions[0] ?? "";
  });

  const readSnap = useCallback(async () => {
    try {
      const v = await invoke<EpicsPayload>("planning_epics_read");
      setPayload(v);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    readSnap();
  }, [readSnap]);

  // B9-CP24 — morning-sweep listener. Refreshes the roadmap from
  // the Ops surface's morning-sweep button.
  useEffect(() => {
    const onSweep = () => triggerRun();
    window.addEventListener("cos:morning-sweep", onSweep);
    return () => window.removeEventListener("cos:morning-sweep", onSweep);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // B8-CP28 — re-read on window focus so coming back from the
  // browser shows whatever the most recent run wrote without a
  // manual click. Doesn't trigger a new run; only re-reads the
  // file. The 30 s tick keeps the freshness chip honest.
  useEffect(() => {
    const onFocus = () => readSnap();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [readSnap]);
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const triggerRun = () => {
    if (refreshing) return;
    runSkill("planning-team-epics", "Refresh roadmap", async () => {
      // Prefer the picker selection; fall back to the snapshot's
      // recorded team if no picker option resolved.
      const selectedTeam = team || payload?.team || undefined;
      const v = await invoke<EpicsPayload>("planning_epics_run", {
        team: selectedTeam,
      });
      setPayload(v);
      return v;
    }).catch((err) => {
      showToast({
        kind: "error",
        text: `Could not refresh roadmap: ${String(err)}`,
        durationMs: 6000,
      });
    });
  };

  const allEpics = payload?.epics ?? [];
  // B9-CP17 — apply search + health filter before column-grouping.
  const epics = useMemo(() => {
    let out = allEpics;
    if (healthFilter !== "all") {
      out = out.filter((e) => epicHealth(e) === healthFilter);
    }
    const q = query.trim().toLowerCase();
    if (q) {
      out = out.filter(
        (e) =>
          e.key.toLowerCase().includes(q) ||
          e.title.toLowerCase().includes(q) ||
          (e.owner ?? "").toLowerCase().includes(q),
      );
    }
    return out;
  }, [allEpics, healthFilter, query]);
  // Group by category for the columns layout.
  const todo = epics.filter(
    (e) => e.category === "To Do" || (!e.category && /to.?do/i.test(e.status ?? "")),
  );
  const wip = epics.filter(
    (e) =>
      e.category === "In Progress" ||
      (!e.category && /(progress|review)/i.test(e.status ?? "")),
  );
  const done = epics.filter(
    (e) =>
      e.category === "Done" ||
      (!e.category && /done|closed/i.test(e.status ?? "")),
  );

  return (
    <div className="cos-roadmap">
      <header className="cos-section-head">
        <h2>Team roadmap</h2>
        <p className="cos-section-lede">
          Jira epics owned by your team. Powered by{" "}
          <code>/planning-team-epics</code>. Health (B8-CP25) +
          stale-pill (B8-CP27) compute from %done and last-update.
        </p>
      </header>
      <div className="cos-tabs" role="tablist" aria-label="Roadmap section">
        <button
          type="button"
          role="tab"
          aria-selected={true}
          className="cos-tab is-active"
          onClick={() => onSwitch("epics")}
        >
          Epics
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={false}
          className="cos-tab"
          onClick={() => onSwitch("discovery")}
        >
          Discovery
        </button>
      </div>
      <div className="cos-prs-controls">
        {teamOptions.length > 1 && (
          <select
            className="cos-text-input"
            value={team}
            onChange={(e) => setTeam(e.target.value)}
            aria-label="Team scope"
            style={{ flex: "0 0 auto" }}
          >
            {teamOptions.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        )}
        <input
          type="search"
          className="cos-text-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by key, title, or owner…"
          aria-label="Filter epics"
          style={{ flex: "0 0 auto", maxWidth: 280 }}
        />
        <button
          type="button"
          className="cos-btn cos-btn-ghost"
          onClick={triggerRun}
          disabled={refreshing}
        >
          {refreshing ? "Fetching…" : "Refresh"}
        </button>
        {payload?.fetched_at && (
          <span className="cos-prs-fetched">
            fetched {touchedLabel(payload.fetched_at)}
          </span>
        )}
        {payload?.team && (
          <span className="cos-chip cos-chip-info">{payload.team}</span>
        )}
        {epics.length > 0 && (
          <span className="cos-prs-count">
            {epics.length}/{allEpics.length} epics
          </span>
        )}
      </div>
      <div className="cos-task-filter-chips">
        {(["all", "red", "amber", "green"] as const).map((h) => (
          <button
            key={h}
            type="button"
            className={`cos-chip cos-chip-clickable${healthFilter === h ? " is-active" : ""}`}
            onClick={() => setHealthFilter(h)}
          >
            {h === "all" ? "All health" : h}
          </button>
        ))}
      </div>
      {payload?.mcp_error && (
        <div className="cos-empty cos-empty-error">
          <p>Atlassian MCP: {payload.mcp_error}</p>
          <p className="cos-helper-text">
            See Settings → Plugins to verify the {"<your-atlassian-plugin>"} plugin
            is configured.
          </p>
        </div>
      )}
      {error && (
        <div className="cos-empty cos-empty-error">
          <p>Could not load roadmap.</p>
          <p className="cos-helper-text">{error}</p>
        </div>
      )}
      {epics.length === 0 && !error && !payload?.mcp_error && (
        <div className="cos-empty">
          <p>
            {payload?.fetched_at
              ? "No open epics for this team."
              : "No snapshot yet — click Refresh to run /planning-team-epics."}
          </p>
        </div>
      )}
      {epics.length > 0 && (
        <div className="cos-roadmap-grid">
          <RoadmapColumn label="To Do" epics={todo} />
          <RoadmapColumn label="In Progress" epics={wip} />
          <RoadmapColumn label="Done" epics={done} />
        </div>
      )}
    </div>
  );
}

// B9-CP21 — Discovery (JPD) sub-tab. Mirrors the Epics tab's
// load-on-mount + refresh pattern but renders a flat list sorted
// by score desc.
type JpdIdea = {
  key: string;
  title: string;
  status?: string;
  score?: number;
  url?: string;
  owner?: string;
  updated?: string;
};
type JpdPayload = {
  fetched_at: string | null;
  ideas: JpdIdea[];
  mcp_error?: string;
};

function DiscoveryTab({
  onSwitch,
}: {
  onSwitch: (next: "epics" | "discovery") => void;
}) {
  const [payload, setPayload] = useState<JpdPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const r = useRun("planning-jpd");
  const refreshing = r?.state === "running";

  const readSnap = useCallback(async () => {
    try {
      const v = await invoke<JpdPayload>("planning_jpd_read");
      setPayload(v);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, []);
  useEffect(() => {
    readSnap();
  }, [readSnap]);

  const triggerRun = () => {
    if (refreshing) return;
    runSkill("planning-jpd", "Refresh discovery", async () => {
      const v = await invoke<JpdPayload>("planning_jpd_run");
      setPayload(v);
      return v;
    }).catch((err) => {
      showToast({
        kind: "error",
        text: `Could not refresh discovery: ${String(err)}`,
        durationMs: 6000,
      });
    });
  };

  const ideas = (payload?.ideas ?? [])
    .slice()
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  return (
    <div className="cos-roadmap">
      <header className="cos-section-head">
        <h2>Discovery (JPD)</h2>
        <p className="cos-section-lede">
          Jira Product Discovery ideas the team has in flight.
          Sorted by score desc. PRD-110 §5.3.
        </p>
      </header>
      <div className="cos-tabs" role="tablist" aria-label="Roadmap section">
        <button
          type="button"
          role="tab"
          aria-selected={false}
          className="cos-tab"
          onClick={() => onSwitch("epics")}
        >
          Epics
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={true}
          className="cos-tab is-active"
          onClick={() => onSwitch("discovery")}
        >
          Discovery
        </button>
      </div>
      <div className="cos-prs-controls">
        <button
          type="button"
          className="cos-btn cos-btn-ghost"
          onClick={triggerRun}
          disabled={refreshing}
        >
          {refreshing ? "Fetching…" : "Refresh"}
        </button>
        {payload?.fetched_at && (
          <span className="cos-prs-fetched">
            fetched {touchedLabel(payload.fetched_at)}
          </span>
        )}
        {ideas.length > 0 && (
          <span className="cos-prs-count">{ideas.length} ideas</span>
        )}
      </div>
      {payload?.mcp_error && (
        <div className="cos-empty cos-empty-error">
          <p>Atlassian MCP: {payload.mcp_error}</p>
        </div>
      )}
      {error && (
        <div className="cos-empty cos-empty-error">
          <p>{error}</p>
        </div>
      )}
      {ideas.length === 0 && !error && !payload?.mcp_error && (
        <div className="cos-empty">
          <p>
            {payload?.fetched_at
              ? "No discovery items returned."
              : "No snapshot yet — click Refresh to run /planning-jpd."}
          </p>
        </div>
      )}
      {ideas.length > 0 && (
        <ul className="cos-pr-list">
          {ideas.map((it) => (
            <li key={it.key}>
              <button
                type="button"
                className="cos-pr-row"
                onClick={() => {
                  if (it.url) openUrl(it.url).catch(() => {});
                }}
                disabled={!it.url}
              >
                <div className="cos-pr-head">
                  <span className="cos-pr-repo">{it.key}</span>
                  {typeof it.score === "number" && (
                    <span className="cos-chip cos-chip-info">
                      score {it.score.toFixed(1)}
                    </span>
                  )}
                  {it.status && (
                    <span className="cos-chip cos-chip-muted">
                      {it.status}
                    </span>
                  )}
                </div>
                <div className="cos-pr-title">{it.title}</div>
                <div className="cos-pr-meta">
                  {it.owner && <span>{it.owner}</span>}
                  {it.updated && (
                    <>
                      <span aria-hidden> · </span>
                      <span>updated {touchedLabel(it.updated)}</span>
                    </>
                  )}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// B9-CP19 — tiny stacked progress bar on each epic card. Done /
// in-progress / blocked / to-do segments inferred from the
// existing tickets_* counts. To-do = total - (done + blocked +
// approx in-progress). We don't have an in-progress count from the
// snapshot today — best-guess as half of (total - done - blocked)
// so the WIP segment isn't always zero. When PRD-110 grows a
// per-status histogram on epics.json, swap this.
function EpicProgressBar({ epic }: { epic: Epic }) {
  const total = epic.tickets_total ?? 0;
  if (total === 0) return null;
  const done = Math.min(total, epic.tickets_done ?? 0);
  const blocked = Math.min(total - done, epic.tickets_blocked ?? 0);
  const remaining = Math.max(0, total - done - blocked);
  const wip = Math.round(remaining / 2);
  const todo = remaining - wip;
  const seg = (n: number) =>
    total === 0 ? "0%" : `${(n / total) * 100}%`;
  return (
    <span
      className="cos-epic-progress"
      title={`${done} done · ${wip} in progress · ${blocked} blocked · ${todo} to do`}
      aria-label={`${done} of ${total} done`}
    >
      <span className="cos-epic-progress-done" style={{ width: seg(done) }} />
      <span className="cos-epic-progress-wip" style={{ width: seg(wip) }} />
      <span
        className="cos-epic-progress-blocked"
        style={{ width: seg(blocked) }}
      />
      <span className="cos-epic-progress-todo" style={{ width: seg(todo) }} />
    </span>
  );
}

// B9-CP22 — extract Slack URLs from epic title / labels / owner.
// We only have summary fields in epics.json today; no description
// or comments. Best-effort regex against any text we have. When
// /planning-team-epics grows description/comment fields, this
// component picks them up automatically.
function EpicSlackLinks({ epic }: { epic: Epic }) {
  const haystack = useMemo(() => {
    return [
      epic.title,
      epic.owner ?? "",
      ...(epic.labels ?? []),
    ]
      .filter(Boolean)
      .join(" ");
  }, [epic.title, epic.owner, epic.labels]);
  const links = useMemo(() => {
    const re = /https:\/\/[a-z0-9.-]*\.slack\.com\/[^\s)\]"']+/gi;
    return Array.from(haystack.matchAll(re), (m) => m[0]).slice(0, 3);
  }, [haystack]);
  if (links.length === 0) return null;
  return (
    <p className="cos-helper-text">
      <strong>Discussion:</strong>{" "}
      {links.map((url, ix) => (
        <button
          key={`${url}-${ix}`}
          type="button"
          className="cos-btn cos-btn-ghost"
          onClick={(ev) => {
            ev.stopPropagation();
            openUrl(url).catch(() => {});
          }}
          style={{ marginRight: 6 }}
        >
          Slack thread {ix + 1} →
        </button>
      ))}
    </p>
  );
}

// B9-CP18 — best-effort epic ↔ project folder cross-link. We match
// the epic key (e.g. EXAMPLE-1234) against project README front-
// matter / body. Works when the project README mentions the key.
function EpicProjectLink({ epicKey }: { epicKey: string }) {
  type Hit = { rel_path: string; label: string; context: string };
  const [hit, setHit] = useState<Hit | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const hits = await invoke<Hit[]>("content_search", { query: epicKey });
        if (cancelled) return;
        const projectHit = hits.find((h) =>
          h.rel_path.startsWith("projects/"),
        );
        if (projectHit) setHit(projectHit);
      } catch {
        // silent — link stays hidden
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [epicKey]);
  if (!hit) return null;
  return (
    <p className="cos-helper-text">
      <strong>Linked project:</strong>{" "}
      <button
        type="button"
        className="cos-btn cos-btn-ghost"
        onClick={(ev) => {
          ev.stopPropagation();
          window.dispatchEvent(
            new CustomEvent("cos:open-doc", {
              detail: {
                relPath: hit.rel_path,
                label: hit.label,
              },
            }),
          );
        }}
      >
        {hit.label} →
      </button>
    </p>
  );
}

function RoadmapColumn({ label, epics }: { label: string; epics: Epic[] }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  return (
    <section className="cos-roadmap-col">
      <h3 className="cos-roadmap-col-head">
        {label} <span className="cos-roadmap-col-count">{epics.length}</span>
      </h3>
      <ul className="cos-roadmap-list">
        {epics.map((e) => {
          const health = epicHealth(e);
          const stale = isEpicStale(e.updated);
          const expanded = openKey === e.key;
          return (
            <li key={e.key}>
              <button
                type="button"
                className={`cos-epic-card cos-epic-${health}${expanded ? " is-expanded" : ""}`}
                onClick={() => setOpenKey(expanded ? null : e.key)}
                aria-expanded={expanded}
                aria-label={`${e.key}: health ${health}`}
              >
                <div className="cos-epic-head">
                  <span
                    className={`cos-ci-dot cos-ci-${
                      health === "green"
                        ? "green"
                        : health === "amber"
                        ? "yellow"
                        : health === "red"
                        ? "red"
                        : "unknown"
                    }`}
                    aria-hidden
                    title={`Epic health: ${health}`}
                  />
                  <span className="cos-epic-key">{e.key}</span>
                  {e.tickets_total ? (
                    <span className="cos-chip cos-chip-muted">
                      {e.tickets_done ?? 0}/{e.tickets_total}
                    </span>
                  ) : null}
                  <EpicProgressBar epic={e} />
                  {(e.tickets_blocked ?? 0) > 0 && (
                    <span className="cos-chip cos-chip-stale">
                      {e.tickets_blocked} blocked
                    </span>
                  )}
                  {stale && (
                    <span className="cos-chip cos-chip-stale" title="No update in 14d+">
                      stale
                    </span>
                  )}
                </div>
                <div className="cos-epic-title">{e.title}</div>
                <div className="cos-epic-meta">
                  {e.owner && <span>{e.owner}</span>}
                  {e.due && (
                    <>
                      <span aria-hidden> · </span>
                      <span>due {e.due}</span>
                    </>
                  )}
                  {e.updated && (
                    <>
                      <span aria-hidden> · </span>
                      <span>updated {touchedLabel(e.updated)}</span>
                    </>
                  )}
                </div>
              </button>
              {expanded && (
                <div className="cos-epic-detail">
                  <EpicProjectLink epicKey={e.key} />
                  <EpicSlackLinks epic={e} />
                  <dl className="cos-status">
                    <dt>Status</dt>
                    <dd>{e.status ?? "—"}</dd>
                    <dt>Owner</dt>
                    <dd>{e.owner ?? "unassigned"}</dd>
                    <dt>Health</dt>
                    <dd>{health}</dd>
                    {(e.tickets_total ?? 0) > 0 && (
                      <>
                        <dt>Tickets</dt>
                        <dd>
                          {e.tickets_done ?? 0} done /{" "}
                          {e.tickets_total} total
                          {(e.tickets_blocked ?? 0) > 0 && (
                            <> · {e.tickets_blocked} blocked</>
                          )}
                        </dd>
                      </>
                    )}
                    {e.due && (
                      <>
                        <dt>Due</dt>
                        <dd>{e.due}</dd>
                      </>
                    )}
                    {e.updated && (
                      <>
                        <dt>Last update</dt>
                        <dd>{touchedLabel(e.updated)}</dd>
                      </>
                    )}
                    {e.labels && e.labels.length > 0 && (
                      <>
                        <dt>Labels</dt>
                        <dd>{e.labels.join(", ")}</dd>
                      </>
                    )}
                  </dl>
                  <div className="cos-form-actions">
                    {e.url && (
                      <button
                        type="button"
                        className="cos-btn cos-btn-ghost"
                        onClick={() => openUrl(e.url!).catch(() => {})}
                      >
                        Open in Jira →
                      </button>
                    )}
                    <button
                      type="button"
                      className="cos-btn cos-btn-ghost"
                      onClick={() => {
                        runSkill(
                          `planning-epic-update:${e.key}`,
                          `Plan update ${e.key}`,
                          async () => {
                            const r = await invoke<{
                              rel_path: string;
                              summary: string;
                            }>("planning_epic_update", { epicKey: e.key });
                            window.dispatchEvent(
                              new CustomEvent("cos:open-doc", {
                                detail: {
                                  relPath: r.rel_path,
                                  label:
                                    r.rel_path
                                      .split("/")
                                      .pop()
                                      ?.replace(/\.(md|html)$/, "") ?? e.key,
                                },
                              }),
                            );
                            return r;
                          },
                        ).catch((err) => {
                          showToast({
                            kind: "error",
                            text: `Plan update failed: ${String(err)}`,
                            durationMs: 6000,
                          });
                        });
                      }}
                    >
                      Plan update
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
