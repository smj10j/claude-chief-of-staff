import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Info } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

import { createTaskFromText } from "../state/createTask";
import { BlockMarkdown } from "../state/inlineMarkdown";
import { type OpenDoc } from "../state/openDoc";
import { dismissRun, runSkill, useRun } from "../state/skillRuns";
import { showToast } from "../state/toasts";
import { attentionScore, isStale, sortByAttention } from "../state/velocity";
import {
  readPrefs,
  VELOCITY_PREFS_CHANGED,
  filterByPrefs,
} from "../state/velocityPrefs";
import { SurfaceHero, TimeBucket, type TimeBucketTone } from "../ui";

export type V1Task = {
  id: string;
  title: string;
  status: "todo" | "in-progress" | "done";
  priority: "high" | "medium" | "low";
  due: string | null;
  project: string | null;
  notes: string | null;
  tags: string[];
  links: string[];
  created_at: string | null;
  updated_at: string | null;
};

export type V1Status = {
  path: string;
  found: boolean;
};

type Load =
  | { kind: "loading" }
  | { kind: "ok"; tasks: V1Task[]; status: V1Status }
  | { kind: "error"; error: string };

type Props = {
  onSelect: (task: V1Task | null) => void;
  selectedId: string | null;
  refreshNonce: number;
  onOpenDoc: (doc: OpenDoc) => void;
  onCreated: (task: V1Task) => void;
  /** Shell-driven scroll hint. Each new object identity triggers Work to
   *  scroll the matching row into view + flash + auto-expand its bucket.
   *  Used by Shell.handleTaskCreated and the side-panel undo path so
   *  freshly-created/uncompleted tasks are visible even if the user
   *  has manually collapsed the bucket they landed in. */
  scrollHint?: { id: string } | null;
};

async function fetchTasks(): Promise<{ tasks: V1Task[]; status: V1Status }> {
  const [tasks, status] = await Promise.all([
    invoke<V1Task[]>("v1_tasks_list"),
    invoke<V1Status>("v1_tasks_status"),
  ]);
  return { tasks, status };
}

export function Work({ onSelect, selectedId, refreshNonce, onOpenDoc, onCreated, scrollHint }: Props) {
  const triageRun = useRun("task-triage");
  const triaging = triageRun?.state === "running";
  const triageError =
    triageRun?.state === "error" ? triageRun.error ?? null : null;
  const reviewRun = useRun("weekly-review");
  const reviewing = reviewRun?.state === "running";
  const reviewError =
    reviewRun?.state === "error" ? reviewRun.error ?? null : null;

  const runTriage = () => {
    if (triaging) return;
    runSkill("task-triage", "Task triage", async () => {
      const result = await invoke<{ rel_path: string; summary: string }>(
        "task_triage",
      );
      onOpenDoc({
        relPath: result.rel_path,
        label: "triage",
      });
      return result;
    }).catch(() => {
      /* error captured in run state */
    });
  };

  const runWeeklyReview = () => {
    if (reviewing) return;
    runSkill("weekly-review", "Weekly review", async () => {
      const result = await invoke<{ rel_path: string; summary: string }>(
        "weekly_review",
      );
      onOpenDoc({
        relPath: result.rel_path,
        label:
          result.rel_path.split("/").pop()?.replace(/\.md$/, "") ?? "review",
      });
      return result;
    }).catch(() => {
      /* error captured in run state */
    });
  };

  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [scrollToId, setScrollToId] = useState<string | null>(null);
  const [filterMode, setFilterMode] = useState<"all" | "overdue">("all");
  const [filterTag, setFilterTag] = useState<string | null>(null);
  // B8-CP4 — tabs in Work surface. PRD-109 §5.1 "PR queue" lives here
  // alongside Tasks; the Review tab is the same data filtered to
  // "review-requested = me". State persists in sessionStorage so a
  // surface re-mount doesn't drop the user back on Tasks.
  const [tab, setTab] = useState<WorkTab>(() => readPersistedTab());
  useEffect(() => {
    sessionStorage.setItem(WORK_TAB_KEY, tab);
  }, [tab]);

  // B8-CP38 — `[` and `]` cycle Work tabs when no input/textarea is
  // focused. Scoped to this surface so the keys stay free elsewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== "[" && e.key !== "]") return;
      const t = document.activeElement;
      if (
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        (t instanceof HTMLElement && t.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      const ix = WORK_TABS.findIndex((x) => x.id === tab);
      const delta = e.key === "]" ? 1 : -1;
      const next = WORK_TABS[(ix + delta + WORK_TABS.length) % WORK_TABS.length];
      setTab(next.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab]);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchTasks();
      setLoad({ kind: "ok", ...next });
    } catch (error) {
      setLoad({ kind: "error", error: String(error) });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const next = await fetchTasks();
        if (!cancelled) setLoad({ kind: "ok", ...next });
      } catch (error) {
        if (!cancelled) setLoad({ kind: "error", error: String(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshNonce]);

  const [completingId, setCompletingId] = useState<string | null>(null);

  const handleComplete = useCallback(
    async (task: V1Task) => {
      if (busyId) return;
      setBusyId(task.id);
      // PRD-115 §7.7 — task-complete moment: row fades + slides out
      // before the data refresh removes it. The animation runs in
      // CSS via .is-completing; we just wait for it to finish.
      const reduced = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      const animMs = reduced ? 0 : 280;
      setCompletingId(task.id);
      try {
        const completion = invoke("v1_tasks_complete", { id: task.id });
        await Promise.all([
          completion,
          new Promise<void>((resolve) => setTimeout(resolve, animMs)),
        ]);
        if (selectedId === task.id) onSelect(null);
        await refresh();
        showToast({
          kind: "success",
          text: `Done · ${task.title}`,
          action: {
            label: "Undo",
            onClick: async () => {
              try {
                await invoke("v1_tasks_uncomplete", { id: task.id });
                await refresh();
                // Scroll the row into view + flash, and auto-expand
                // the bucket if the user had collapsed it.
                setScrollToId(task.id);
                showToast({
                  kind: "info",
                  text: "Reopened.",
                  durationMs: 2500,
                });
              } catch (error) {
                showToast({
                  kind: "error",
                  text: `Couldn't undo: ${String(error)}`,
                  durationMs: 6000,
                });
              }
            },
          },
          durationMs: 6000,
        });
      } catch (error) {
        console.error("complete_task failed", error);
        showToast({
          kind: "error",
          text: `Could not complete task: ${String(error)}`,
          durationMs: 6000,
        });
      } finally {
        setBusyId(null);
        setCompletingId(null);
      }
    },
    [busyId, onSelect, refresh, selectedId],
  );

  // onOpenDoc is preserved in the public contract but no longer consumed
  // by Work itself (Projects has its own surface).
  void onOpenDoc;

  const handleCreated = useCallback(
    (task: V1Task) => {
      // Scroll the newly-created row into view + flash. Parent bumps the
      // refreshNonce, which reseeds the list at its sorted position.
      setScrollToId(task.id);
      onCreated(task);
    },
    [onCreated],
  );

  // Shell-driven scroll requests (creation, side-panel undo). New
  // object identity = new request; we sync into local scrollToId and
  // the matching bucket auto-expands if the user had collapsed it.
  useEffect(() => {
    if (scrollHint?.id) setScrollToId(scrollHint.id);
  }, [scrollHint]);

  // j/k row navigation. Window-scoped so the user can pick a row from
  // anywhere on the Tasks surface, not just after clicking into the
  // list. Skipped when an input/textarea/contenteditable is focused so
  // typing in NewTaskRow doesn't move the selection.
  useEffect(() => {
    if (load.kind !== "ok") return;
    const tasks = load.tasks;
    function onKey(e: KeyboardEvent) {
      const key = e.key;
      if (key !== "j" && key !== "k") return;
      // Don't steal keystrokes from form fields / the editor.
      const t = e.target as HTMLElement | null;
      if (
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        t?.isContentEditable
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      const ordered = bucketTasks(
        filterMode === "overdue"
          ? tasks.filter(isOverdue)
          : filterTag
            ? tasks.filter((x) => x.tags.includes(filterTag))
            : tasks,
      );
      const flat = [
        ...ordered.now,
        ...ordered.thisWeek,
        ...ordered.soon,
        ...ordered.someday,
      ];
      if (flat.length === 0) return;
      const cur = flat.findIndex((x) => x.id === selectedId);
      let next: number;
      if (cur === -1) {
        next = key === "j" ? 0 : flat.length - 1;
      } else {
        next = key === "j" ? cur + 1 : cur - 1;
      }
      if (next < 0 || next >= flat.length) return;
      const target = flat[next];
      onSelect(target);
      setScrollToId(target.id);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [load, filterMode, filterTag, selectedId, onSelect]);

  return (
    <div className="cos-work">
      <div className="cos-work-tabs cos-tabs" role="tablist" aria-label="Work view">
        {WORK_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`cos-tab${tab === t.id ? " is-active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "tasks" && (
        <TasksTab
          load={load}
          onSelect={onSelect}
          selectedId={selectedId}
          onComplete={handleComplete}
          busyId={busyId}
          completingId={completingId}
          scrollToId={scrollToId}
          onScrollHandled={() => setScrollToId(null)}
          onTriage={runTriage}
          triaging={triaging}
          triageError={triageError}
          onWeeklyReview={runWeeklyReview}
          reviewing={reviewing}
          reviewError={reviewError}
          onCreated={handleCreated}
          filterMode={filterMode}
          filterTag={filterTag}
          onFilterMode={setFilterMode}
          onFilterTag={setFilterTag}
        />
      )}
      {tab === "prs" && <PrsTab kind="authored" />}
      {tab === "review" && <PrsTab kind="review" />}
      {tab === "jira" && <JiraTab />}
    </div>
  );
}

type JiraIssue = {
  key: string;
  title: string;
  status?: string;
  priority?: string | null;
  type?: string;
  due?: string | null;
  updated?: string;
  url?: string;
  epic_key?: string;
  labels?: string[];
};

type JiraPayload = {
  fetched_at: string | null;
  issues: JiraIssue[];
  missing?: boolean;
  mcp_error?: string;
};

/** Work → Jira (B8-CP22). Mirrors PrsTab's pattern: read on mount,
 *  manual + focus refresh, eager run via runSkill. The skill writes
 *  data/files/areas/work/my-jira.json; we read that. */
function JiraTab() {
  // B9-CP16 — sub-tab between "my" issues and "team" issues. Persists
  // in sessionStorage so the user lands where they left off.
  const [scope, setScope] = useState<"my" | "team">(() => {
    const raw = sessionStorage.getItem("cos:jira-scope");
    return raw === "team" ? "team" : "my";
  });
  useEffect(() => {
    sessionStorage.setItem("cos:jira-scope", scope);
  }, [scope]);
  const [payload, setPayload] = useState<JiraPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const skillId = scope === "my" ? "ops-my-jira" : "ops-team-jira";
  const ipcRun = scope === "my" ? "jira_my_run" : "jira_team_run";
  const ipcRead = scope === "my" ? "jira_my_read" : "jira_team_read";
  const run = useRun(skillId);
  const refreshing = run?.state === "running";
  // B9-CP15 — search + status filter chips. State per-tab.
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const readSnap = useCallback(async () => {
    try {
      const v = await invoke<JiraPayload>(ipcRead);
      setPayload(v);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [ipcRead]);

  useEffect(() => {
    readSnap();
  }, [readSnap]);

  const triggerRun = () => {
    if (refreshing) return;
    runSkill(skillId, scope === "my" ? "Refresh my Jira" : "Refresh team Jira", async () => {
      const v = await invoke<JiraPayload>(ipcRun);
      setPayload(v);
      return v;
    }).catch((err) => {
      showToast({
        kind: "error",
        text: `Could not refresh Jira: ${String(err)}`,
        durationMs: 6000,
      });
    });
  };

  const allIssues = payload?.issues ?? [];
  // B9-CP15 — distinct status set used for the filter chips. Sorted
  // by frequency so the most-common ones land on the left.
  const statusBuckets = useMemo(() => {
    const counts = new Map<string, number>();
    for (const i of allIssues) {
      const s = (i.status ?? "—").trim();
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  }, [allIssues]);
  const issues = useMemo(() => {
    let out = allIssues;
    if (statusFilter !== "all") {
      out = out.filter((i) => (i.status ?? "—").trim() === statusFilter);
    }
    const q = query.trim().toLowerCase();
    if (q) {
      out = out.filter(
        (i) =>
          i.key.toLowerCase().includes(q) ||
          i.title.toLowerCase().includes(q),
      );
    }
    return out;
  }, [allIssues, statusFilter, query]);
  return (
    <div className="cos-prs-tab">
      <header className="cos-section-head">
        <h2>{scope === "my" ? "My open Jira" : "Team open Jira"}</h2>
        <p className="cos-section-lede">
          {scope === "my"
            ? "Issues currently assigned to you that aren't Done."
            : "Issues open across your team that aren't Done."}{" "}
          Powered by the Atlassian MCP via{" "}
          <code>/{skillId}</code>.
        </p>
      </header>
      <div className="cos-tabs" role="tablist" aria-label="Jira scope">
        <button
          type="button"
          role="tab"
          aria-selected={scope === "my"}
          className={`cos-tab${scope === "my" ? " is-active" : ""}`}
          onClick={() => setScope("my")}
        >
          My
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={scope === "team"}
          className={`cos-tab${scope === "team" ? " is-active" : ""}`}
          onClick={() => setScope("team")}
        >
          Team
        </button>
      </div>
      <div className="cos-prs-controls">
        <input
          type="search"
          className="cos-text-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by key or title…"
          aria-label="Filter Jira issues"
          style={{ flex: "0 0 auto", maxWidth: 280 }}
        />
      </div>
      {statusBuckets.length > 0 && (
        <div className="cos-task-filter-chips">
          <button
            type="button"
            className={`cos-chip cos-chip-clickable${statusFilter === "all" ? " is-active" : ""}`}
            onClick={() => setStatusFilter("all")}
          >
            All ({allIssues.length})
          </button>
          {statusBuckets.map(([status, count]) => (
            <button
              key={status}
              type="button"
              className={`cos-chip cos-chip-clickable${statusFilter === status ? " is-active" : ""}`}
              onClick={() => setStatusFilter(status)}
            >
              {status} ({count})
            </button>
          ))}
        </div>
      )}
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
            fetched {formatRelative(payload.fetched_at)}
          </span>
        )}
        {issues.length > 0 && (
          <span className="cos-prs-count">{issues.length} open</span>
        )}
      </div>
      {payload?.mcp_error && (
        <div className="cos-empty cos-empty-error">
          <p>MCP error: {payload.mcp_error}</p>
        </div>
      )}
      {error && <p className="cos-bad">{error}</p>}
      {issues.length === 0 && !error && (
        <div className="cos-empty">
          <p>
            {payload?.fetched_at
              ? "No open Jira issues. Inbox zero."
              : "No snapshot yet — click Refresh."}
          </p>
        </div>
      )}
      {issues.length > 0 && (
        <ul className="cos-pr-list">
          {issues.map((it) => (
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
                  {it.type && (
                    <span className="cos-chip cos-chip-muted">{it.type}</span>
                  )}
                  {it.priority && (
                    <span className="cos-chip cos-chip-info">
                      {it.priority}
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
                  {it.updated && (
                    <span>updated {formatRelative(it.updated)}</span>
                  )}
                  {it.due && (
                    <>
                      <span aria-hidden> · </span>
                      <span>due {it.due}</span>
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

// B8-CP4 — Velocity tab definitions. The list is exported so the
// command palette / shortcut handler can render the same labels.
export type WorkTab = "tasks" | "prs" | "review" | "jira";
export const WORK_TABS: readonly { id: WorkTab; label: string }[] = [
  { id: "tasks", label: "Tasks" },
  { id: "prs", label: "PRs" },
  { id: "review", label: "Review" },
  { id: "jira", label: "Jira" },
] as const;
const WORK_TAB_KEY = "cos:work-tab";
function readPersistedTab(): WorkTab {
  const raw = sessionStorage.getItem(WORK_TAB_KEY);
  if (
    raw === "prs" ||
    raw === "review" ||
    raw === "tasks" ||
    raw === "jira"
  ) {
    return raw;
  }
  return "tasks";
}

/** B9-CP13 — small at-a-glance stats card above the PRs tab. Pure
 *  client-side stats over whatever's loaded, so it tracks the
 *  current filter / refresh without an extra fetch.
 *
 *  - PRs opened in the last 7 days
 *  - Drafts (separate count so the user can spot WIP volume)
 *  - Median age of open PRs (days)
 *  - Stale count (>48h since last activity, mirroring isStale)
 */
function VelocityStats({ rows }: { rows: PrRow[] }) {
  const stats = useMemo(() => {
    const now = Date.now();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    let openedThisWeek = 0;
    let drafts = 0;
    let stale = 0;
    const ages: number[] = [];
    for (const r of rows) {
      const created = Date.parse(r.created_at);
      if (!Number.isNaN(created)) {
        if (now - created < sevenDays) openedThisWeek++;
        ages.push((now - created) / (1000 * 60 * 60 * 24));
      }
      if (r.is_draft) drafts++;
      if (isStale(r.updated_at, now)) stale++;
    }
    ages.sort((a, b) => a - b);
    const medianAge =
      ages.length === 0 ? 0 : ages[Math.floor(ages.length / 2)];
    return {
      total: rows.length,
      openedThisWeek,
      drafts,
      stale,
      medianAge: medianAge.toFixed(1),
    };
  }, [rows]);
  return (
    <div className="cos-velocity-stats" aria-label="Velocity at a glance">
      <Stat label="Open" value={stats.total} />
      <Stat label="Opened (7d)" value={stats.openedThisWeek} />
      <Stat label="Drafts" value={stats.drafts} />
      <Stat label="Stale" value={stats.stale} />
      <Stat label="Median age" value={`${stats.medianAge}d`} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="cos-velocity-stat">
      <div className="cos-velocity-stat-value">{value}</div>
      <div className="cos-velocity-stat-label">{label}</div>
    </div>
  );
}

/** Hook for B8-CP33: run `/velocity-diagnose` and emit the resulting
 *  rel_path via a CustomEvent so any caller (Shell, Work) can open
 *  the doc with the standard openDoc contract without prop-drilling.
 */
function useDiagnoseVelocity() {
  const run = useRun("velocity-diagnose");
  const running = run?.state === "running";
  const trigger = () => {
    if (running) return;
    runSkill("velocity-diagnose", "Velocity diagnose", async () => {
      const result = await invoke<{ rel_path: string; summary: string }>(
        "velocity_diagnose",
      );
      window.dispatchEvent(
        new CustomEvent("cos:open-doc", {
          detail: {
            relPath: result.rel_path,
            label:
              result.rel_path.split("/").pop()?.replace(/\.md$/, "") ??
              "diagnose",
          },
        }),
      );
      return result;
    }).catch((err) => {
      showToast({
        kind: "error",
        text: `Could not diagnose velocity: ${String(err)}`,
        durationMs: 6000,
      });
    });
  };
  return { running, trigger };
}

/**
 * One PR as the v2 surface uses it. Mirrors the Rust `github::PrRow`
 * shape — every field declared here must exist in the IPC payload.
 */
export type PrRow = {
  number: number;
  title: string;
  url: string;
  repo: string;
  author: string;
  author_is_bot: boolean;
  is_draft: boolean;
  created_at: string;
  updated_at: string;
  labels: string[];
};

type PrLoad =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; rows: PrRow[]; fetchedAt: number }
  | { kind: "error"; error: string };

export type CiStatus = {
  state: "green" | "yellow" | "red" | "unknown";
  summary: string;
};

export type PrReview = {
  author: string;
  state: string;
  body: string;
  submitted_at: string;
};

export type PrDetail = {
  body: string;
  reviews: PrReview[];
  reviewer_count: number;
};

/**
 * Velocity tabs (B8-CP4 + CP5/CP7). PRD-109 §5.1. Authored PRs go
 * through `gh_my_prs`; review-requested PRs go through
 * `gh_review_requests`. The tab keeps last-fetched state in memory
 * and renders a manual "Refresh" affordance — auto-refresh lands in
 * B8-CP13.
 */
function PrsTab({ kind }: { kind: "authored" | "review" }) {
  const heading = kind === "authored" ? "Open PRs" : "Awaiting your review";
  const blurb =
    kind === "authored"
      ? "Pull requests you've opened that are still open. Sorted by attention score (PRD-109 §5.1) in B8-CP8."
      : "Pull requests where someone explicitly asked for your review. The action list — these are the ones blocking other people.";
  const ipcCommand = kind === "authored" ? "gh_my_prs" : "gh_review_requests";

  const cacheKey = `cos:pr-cache:${kind}`;
  // B9-CP9 — search box. Pure client-side filter against title /
  // repo / author. Per-tab so authored / review / future jira
  // each remember their own query.
  const [query, setQuery] = useState("");
  // B9-CP10 — group-by-repo toggle, persisted per-tab.
  const groupKey = `cos:pr-group:${kind}`;
  const [grouped, setGrouped] = useState<boolean>(() => {
    return localStorage.getItem(groupKey) === "1";
  });
  useEffect(() => {
    localStorage.setItem(groupKey, grouped ? "1" : "0");
  }, [grouped, groupKey]);
  // B9-CP11 — per-PR detail (body + reviews) fetched on row expand.
  // Lives alongside the score-breakdown so the same chevron toggles
  // both views; the detail load is async and shows a small pending
  // line while gh runs.
  const [detailByUrl, setDetailByUrl] = useState<Record<string, PrDetail | "loading" | "error">>({});
  const [load, setLoad] = useState<PrLoad>(() => {
    // B8-CP35 — render the last cached payload immediately on cold
    // mount so the tab feels instant, then re-fetch in the
    // background. The fetched-at chip will say "fetched 1h ago" or
    // similar until the live fetch lands.
    try {
      const raw = localStorage.getItem(cacheKey);
      if (!raw) return { kind: "idle" };
      const parsed = JSON.parse(raw) as { rows: PrRow[]; fetchedAt: number };
      if (Array.isArray(parsed.rows)) {
        return { kind: "ok", rows: parsed.rows, fetchedAt: parsed.fetchedAt };
      }
    } catch {
      // ignore — fall through to idle
    }
    return { kind: "idle" };
  });
  // B8-CP9 — which row is showing the score breakdown. null = none.
  // Toggling the same id closes; toggling a different one swaps.
  const [scoreOpenFor, setScoreOpenFor] = useState<string | null>(null);
  const diagnose = useDiagnoseVelocity();
  // B8-CP11 — CI status by url. We eager-fetch the top 10 rows once
  // the PR list arrives so the dot is visible without an extra
  // click; below the fold lazy-fills as the user scrolls.
  const [ciByUrl, setCiByUrl] = useState<Record<string, CiStatus>>({});
  // B9-CP41 — reviewer count by url, used by attention scoring.
  // Same eager-fetch budget as CI.
  const [reviewerCountByUrl, setReviewerCountByUrl] = useState<
    Record<string, number>
  >({});
  const fetchPrs = useCallback(async () => {
    setLoad((prev) =>
      prev.kind === "ok" ? prev : { kind: "loading" },
    );
    try {
      const rows = await invoke<PrRow[]>(ipcCommand);
      // Filter bots / excluded authors before scoring so they don't
      // skew the order or eat eager-CI fetch budget.
      const prefs = readPrefs();
      const filtered = filterByPrefs(rows, prefs);
      const ordered = sortByAttention(filtered) as PrRow[];
      const fetchedAt = Date.now();
      setLoad({ kind: "ok", rows: ordered, fetchedAt });
      try {
        localStorage.setItem(
          cacheKey,
          JSON.stringify({ rows: ordered, fetchedAt }),
        );
      } catch {
        // localStorage may be denied; never load-bearing
      }
      const targets = ordered.slice(0, 10);
      for (const pr of targets) {
        invoke<CiStatus>("gh_pr_ci", { repo: pr.repo, number: pr.number })
          .then((status) =>
            setCiByUrl((prev) => ({ ...prev, [pr.url]: status })),
          )
          .catch(() => {
            /* silent — row falls back to "unknown" */
          });
        invoke<PrDetail>("gh_pr_detail", {
          repo: pr.repo,
          number: pr.number,
        })
          .then((d) => {
            setReviewerCountByUrl((prev) => ({
              ...prev,
              [pr.url]: d.reviewer_count,
            }));
            // Stash the detail too so the expand is instant.
            setDetailByUrl((prev) => ({ ...prev, [pr.url]: d }));
          })
          .catch(() => {
            /* silent — score uses default reviewer count of 1 */
          });
      }
    } catch (error) {
      setLoad((prev) =>
        prev.kind === "ok"
          ? prev // keep showing the cached rows; surface the error elsewhere
          : { kind: "error", error: String(error) },
      );
    }
  }, [ipcCommand, cacheKey]);

  // Fetch on first mount of this tab. The auto-fetch on initial
  // selection is what makes the tab feel "live" without a manual
  // Refresh click on every visit.
  useEffect(() => {
    fetchPrs();
  }, [fetchPrs]);

  // B8-CP12 — when the user updates the bot-exclusion list in
  // Settings, refetch so the rendered list reflects the change
  // without a manual Refresh click.
  useEffect(() => {
    const onChange = () => fetchPrs();
    window.addEventListener(VELOCITY_PREFS_CHANGED, onChange);
    return () => window.removeEventListener(VELOCITY_PREFS_CHANGED, onChange);
  }, [fetchPrs]);

  // B9-CP24 — morning-sweep listener. The Ops surface fires the
  // event from its hero button; PR tabs join the fan-out.
  useEffect(() => {
    const onSweep = () => fetchPrs();
    window.addEventListener("cos:morning-sweep", onSweep);
    return () => window.removeEventListener("cos:morning-sweep", onSweep);
  }, [fetchPrs]);

  // B8-CP13 — auto-refresh every 5 min while the tab is mounted so
  // a manager who leaves PRs open in the background sees an
  // up-to-date list when they look back. We refetch on focus too,
  // so coming back from the browser is fresh without waiting for
  // the timer.
  useEffect(() => {
    const interval = window.setInterval(fetchPrs, 5 * 60 * 1000);
    const onFocus = () => fetchPrs();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [fetchPrs]);

  // Tick the "Nm ago" chip every 30s so it stays honest without
  // forcing a re-render of the whole row list. The fetchedAt value
  // doesn't change between actual refreshes; nudging this timer
  // re-renders only the chip via the small useState below.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);

  return (
    <div className="cos-prs-tab">
      <header className="cos-section-head">
        <h2>{heading}</h2>
        <p className="cos-section-lede">{blurb}</p>
      </header>
      {load.kind === "ok" &&
        load.rows.length > 0 &&
        kind === "authored" && <VelocityStats rows={load.rows} />}
      <div className="cos-prs-controls">
        <input
          type="search"
          className="cos-text-input"
          placeholder="Filter by title, repo, or author…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter PRs"
          style={{ flex: "0 0 auto", maxWidth: 280 }}
        />
        <button
          type="button"
          className="cos-btn cos-btn-ghost"
          onClick={fetchPrs}
          disabled={load.kind === "loading"}
        >
          {load.kind === "loading" ? "Fetching…" : "Refresh"}
        </button>
        <label className="cos-checkbox">
          <input
            type="checkbox"
            checked={grouped}
            onChange={(e) => setGrouped(e.target.checked)}
          />
          <span>Group by repo</span>
        </label>
        {load.kind === "ok" && (
          <>
            <span className="cos-prs-count">
              {kind === "authored"
                ? `${load.rows.length} open`
                : `${load.rows.length} blocking`}
            </span>
            <span
              className="cos-prs-fetched"
              title={`Last fetched at ${new Date(load.fetchedAt).toLocaleTimeString()}`}
            >
              fetched {formatRelative(new Date(load.fetchedAt).toISOString())}
            </span>
            {kind === "review" && load.rows.length > 0 && (
              <button
                type="button"
                className="cos-btn cos-btn-ghost"
                onClick={() => {
                  for (const pr of load.rows) {
                    openUrl(pr.url).catch(() => {
                      /* per-row failure surfaces on click */
                    });
                  }
                }}
                title="Open every review-requested PR in the browser"
              >
                Open all
              </button>
            )}
            {kind === "authored" && (
              <button
                type="button"
                className="cos-btn cos-btn-ghost"
                onClick={diagnose.trigger}
                disabled={diagnose.running}
                title="Run /velocity-diagnose"
              >
                {diagnose.running ? "Diagnosing…" : "Diagnose"}
              </button>
            )}
          </>
        )}
      </div>
      {load.kind === "loading" && (
        <p className="cos-pending">Asking gh…</p>
      )}
      {load.kind === "error" && (
        <div className="cos-empty cos-empty-error">
          <p>Could not fetch PRs.</p>
          <p className="cos-helper-text">{load.error}</p>
          <p className="cos-helper-text">
            Check Settings → GitHub. If gh isn't authed, run{" "}
            <code>gh auth login</code> in a terminal first.
          </p>
        </div>
      )}
      {load.kind === "ok" && load.rows.length === 0 && (
        <div className="cos-empty">
          <p>
            {kind === "authored"
              ? "No open PRs from you."
              : "Nothing waiting on your review. Inbox zero."}
          </p>
        </div>
      )}
      {load.kind === "ok" && load.rows.length > 0 && (() => {
        const q = query.trim().toLowerCase();
        const visible = !q
          ? load.rows
          : load.rows.filter((pr) => {
              return (
                pr.title.toLowerCase().includes(q) ||
                pr.repo.toLowerCase().includes(q) ||
                pr.author.toLowerCase().includes(q) ||
                pr.labels.some((l) => l.toLowerCase().includes(q))
              );
            });
        if (visible.length === 0) {
          return (
            <div className="cos-empty">
              <p>No PRs match "{query}".</p>
            </div>
          );
        }
        // B9-CP10 — when grouped, partition by repo while preserving
        // attention-score order inside each group. The list still
        // renders top-down score-first; grouping just inserts a
        // repo header before each block.
        const groups: { repo: string; rows: PrRow[] }[] = [];
        if (grouped) {
          const seen = new Map<string, PrRow[]>();
          for (const pr of visible) {
            const list = seen.get(pr.repo) ?? [];
            list.push(pr);
            seen.set(pr.repo, list);
          }
          for (const [repo, rows] of seen) {
            groups.push({ repo, rows });
          }
        }
        const renderRow = (pr: PrRow) => {
            const reviewerCount = reviewerCountByUrl[pr.url];
            const ciState = ciByUrl[pr.url]?.state;
            const scored = attentionScore({
              ...pr,
              ci_status:
                ciState === "green" ||
                ciState === "yellow" ||
                ciState === "red"
                  ? ciState
                  : null,
              reviewer_count: reviewerCount,
            });
            const open = scoreOpenFor === pr.url;
            return (
              <li key={pr.url}>
                <div className={`cos-pr-card${open ? " is-expanded" : ""}`}>
                  <button
                    type="button"
                    className="cos-pr-row"
                    onClick={() => {
                      openUrl(pr.url).catch((err) => {
                        showToast({
                          kind: "error",
                          text: `Could not open: ${String(err)}`,
                          durationMs: 4000,
                        });
                      });
                    }}
                    title={`Open ${pr.url}`}
                  >
                    <div className="cos-pr-head">
                      {(() => {
                        const ci = ciByUrl[pr.url];
                        return (
                          <span
                            className={`cos-ci-dot cos-ci-${ci?.state ?? "unknown"}`}
                            aria-label={`CI ${ci?.state ?? "unknown"}`}
                            title={
                              ci ? `CI: ${ci.summary}` : "CI: not yet fetched"
                            }
                          />
                        );
                      })()}
                      <span className="cos-pr-repo">{pr.repo}</span>
                      <span className="cos-pr-num">#{pr.number}</span>
                      {pr.is_draft && (
                        <span className="cos-chip cos-chip-muted">draft</span>
                      )}
                      {isStale(pr.updated_at) && (
                        <span
                          className="cos-chip cos-chip-stale"
                          title="No activity in 48h+"
                        >
                          stale
                        </span>
                      )}
                      <span
                        className="cos-pr-score"
                        title="Attention score"
                        aria-label={`attention score ${scored.score.toFixed(2)}`}
                      >
                        {scored.score.toFixed(2)}
                      </span>
                      <ExternalLink
                        size={12}
                        strokeWidth={1.75}
                        aria-hidden
                        className="cos-pr-extlink"
                      />
                    </div>
                    <div className="cos-pr-title">{pr.title}</div>
                    <div className="cos-pr-meta">
                      <span>{pr.author}</span>
                      <span aria-hidden> · </span>
                      <span>updated {formatRelative(pr.updated_at)}</span>
                      {pr.labels.length > 0 && (
                        <>
                          <span aria-hidden> · </span>
                          <span>{pr.labels.slice(0, 3).join(", ")}</span>
                        </>
                      )}
                    </div>
                  </button>
                  <button
                    type="button"
                    className="cos-pr-info"
                    onClick={() => {
                      const next = open ? null : pr.url;
                      setScoreOpenFor(next);
                      // B9-CP11 — fetch detail on first expand only.
                      if (next && !detailByUrl[next]) {
                        setDetailByUrl((prev) => ({ ...prev, [next]: "loading" }));
                        invoke<PrDetail>("gh_pr_detail", {
                          repo: pr.repo,
                          number: pr.number,
                        })
                          .then((d) =>
                            setDetailByUrl((prev) => ({ ...prev, [next]: d })),
                          )
                          .catch(() =>
                            setDetailByUrl((prev) => ({ ...prev, [next]: "error" })),
                          );
                      }
                    }}
                    aria-expanded={open}
                    aria-label={
                      open
                        ? "Hide PR detail"
                        : "Show PR detail (description + recent reviews)"
                    }
                    title="Score breakdown, description, recent reviews"
                  >
                    <Info size={14} strokeWidth={1.75} aria-hidden />
                  </button>
                </div>
                {open && (
                  <>
                    <dl className="cos-pr-score-breakdown">
                      <dt>Age</dt>
                      <dd>×{scored.factors.age.toFixed(2)}</dd>
                      <dt>CI</dt>
                      <dd>×{scored.factors.ci.toFixed(2)}</dd>
                      <dt>Label</dt>
                      <dd>×{scored.factors.label.toFixed(2)}</dd>
                      <dt>Staleness</dt>
                      <dd>×{scored.factors.staleness.toFixed(2)}</dd>
                      <dt>Reviewers</dt>
                      <dd>÷{scored.factors.reviewers}</dd>
                      <dt>Score</dt>
                      <dd>
                        <strong>{scored.score.toFixed(2)}</strong>
                      </dd>
                    </dl>
                    {(() => {
                      const d = detailByUrl[pr.url];
                      if (d === "loading") {
                        return (
                          <p className="cos-pending cos-pr-detail-pending">
                            Loading description + reviews…
                          </p>
                        );
                      }
                      if (d === "error") {
                        return (
                          <p className="cos-bad cos-pr-detail-pending">
                            Could not load PR detail.
                          </p>
                        );
                      }
                      if (!d) return null;
                      const preview =
                        d.body.length > 320
                          ? d.body.slice(0, 320) + "…"
                          : d.body;
                      return (
                        <div className="cos-pr-detail">
                          {preview && (
                            <p className="cos-pr-detail-body">{preview}</p>
                          )}
                          {d.reviews.length > 0 && (
                            <ul className="cos-pr-detail-reviews">
                              {d.reviews.map((r, ix) => (
                                <li key={`${r.author}-${ix}`}>
                                  <span
                                    className={`cos-pr-detail-review-state cos-pr-detail-review-${r.state.toLowerCase()}`}
                                  >
                                    {r.state}
                                  </span>{" "}
                                  <strong>{r.author}</strong>
                                  {r.body && <>: {r.body}</>}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      );
                    })()}
                  </>
                )}
              </li>
            );
          };
        return grouped ? (
          <div className="cos-pr-groups">
            {groups.map((g) => (
              <section key={g.repo} className="cos-pr-group">
                <h3 className="cos-pr-group-head">
                  <code>{g.repo}</code>
                  <span className="cos-pr-group-count">{g.rows.length}</span>
                </h3>
                <ul className="cos-pr-list">{g.rows.map(renderRow)}</ul>
              </section>
            ))}
          </div>
        ) : (
          <ul className="cos-pr-list">{visible.map(renderRow)}</ul>
        );
      })()}
    </div>
  );
}

export function formatRelative(iso: string): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const ms = Date.now() - t;
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(t).toLocaleDateString();
}

function TasksTab({
  load,
  onSelect,
  selectedId,
  onComplete,
  busyId,
  completingId,
  scrollToId,
  onScrollHandled,
  onTriage,
  triaging,
  triageError,
  onWeeklyReview,
  reviewing,
  reviewError,
  onCreated,
  filterMode,
  filterTag,
  onFilterMode,
  onFilterTag,
}: {
  load: Load;
  onSelect: (task: V1Task | null) => void;
  selectedId: string | null;
  onComplete: (task: V1Task) => void;
  busyId: string | null;
  completingId: string | null;
  scrollToId: string | null;
  onScrolled?: () => void;
  onScrollHandled: () => void;
  onTriage: () => void;
  triaging: boolean;
  triageError: string | null;
  onWeeklyReview: () => void;
  reviewing: boolean;
  reviewError: string | null;
  onCreated: (task: V1Task) => void;
  filterMode: "all" | "overdue";
  filterTag: string | null;
  onFilterMode: (mode: "all" | "overdue") => void;
  onFilterTag: (tag: string | null) => void;
}) {
  // Single shared callback so every TaskRow's tag chips go through
  // the same "set + filter" path. Toggling the same tag clears the
  // filter (matches the chip strip's behavior in CP6).
  const onTagClick = useCallback(
    (tag: string) => {
      onFilterTag(filterTag === tag ? null : tag);
    },
    [filterTag, onFilterTag],
  );
  // Distinct tags from the loaded task set, sorted by frequency desc.
  // Used to render the chip strip — we don't want to nag the user with
  // every conceivable tag, just the top ~6 they actually use.
  const topTags = useMemo(() => {
    if (load.kind !== "ok") return [];
    const counts = new Map<string, number>();
    for (const t of load.tasks) {
      for (const tag of t.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 6)
      .map(([tag]) => tag);
  }, [load]);

  const filtered = useMemo(() => {
    if (load.kind !== "ok") return load;
    let tasks = load.tasks;
    if (filterMode === "overdue") {
      tasks = tasks.filter((t) => isOverdue(t));
    }
    if (filterTag) {
      tasks = tasks.filter((t) => t.tags.includes(filterTag));
    }
    return { ...load, tasks };
  }, [load, filterMode, filterTag]);

  const buckets = useMemo(() => {
    if (filtered.kind !== "ok") return null;
    return bucketTasks(filtered.tasks);
  }, [filtered]);

  const subtitleText = useMemo(() => {
    if (!buckets) return "Loading…";
    const overdue = buckets.now.filter((t) => isOverdue(t)).length;
    const dueToday = buckets.now.length - overdue;
    if (overdue === 0 && dueToday === 0) {
      const week = buckets.thisWeek.length;
      if (week === 0) return "Inbox zero. Nice.";
      return `Nothing overdue. ${week} due this week.`;
    }
    const parts: string[] = [];
    if (overdue > 0) parts.push(`${overdue} overdue`);
    if (dueToday > 0) parts.push(`${dueToday} due today`);
    return parts.join(" · ");
  }, [buckets]);

  // The v1-database pill is intentionally gone — the same info lives
  // on Settings → Diagnostics, where it's the relevant context for
  // "is the backend wiring healthy?". Above the task list it's just
  // visual noise.
  const heroSubtitle = subtitleText;

  return (
    <>
      <SurfaceHero
        title="Tasks"
        subtitle={heroSubtitle}
        actions={
          <>
            <button
              type="button"
              className="cos-btn cos-btn-ghost"
              onClick={onTriage}
              disabled={triaging}
              title="Run /task-triage — surface overdue/stale tasks for review in a triage doc"
            >
              {triaging ? (
                <>
                  <span className="cos-newtask-spinner" aria-hidden /> triaging…
                </>
              ) : (
                "Triage"
              )}
            </button>
            <button
              type="button"
              className="cos-btn cos-btn-ghost"
              onClick={onWeeklyReview}
              disabled={reviewing}
              title="Run /weekly-review — Friday GTD-style review with task triage + project health + next-week preview"
            >
              {reviewing ? (
                <>
                  <span className="cos-newtask-spinner" aria-hidden /> reviewing…
                </>
              ) : (
                "Weekly review"
              )}
            </button>
          </>
        }
      />
      {load.kind === "ok" && load.status.found && (
        <NewTaskRow onCreated={onCreated} />
      )}
      {load.kind === "ok" && load.status.found && load.tasks.length > 0 && (
        <div className="cos-task-filters" role="toolbar" aria-label="Task filters">
          <button
            type="button"
            className={`cos-task-filter-chip${filterMode === "all" ? " is-active" : ""}`}
            onClick={() => onFilterMode("all")}
          >
            All
          </button>
          <button
            type="button"
            className={`cos-task-filter-chip${filterMode === "overdue" ? " is-active" : ""}`}
            onClick={() => onFilterMode("overdue")}
          >
            Overdue
          </button>
          {topTags.length > 0 && (
            <span className="cos-task-filter-sep" aria-hidden />
          )}
          {topTags.map((tag) => (
            <button
              key={tag}
              type="button"
              className={`cos-task-filter-chip${
                filterTag === tag ? " is-active" : ""
              }`}
              onClick={() => onFilterTag(filterTag === tag ? null : tag)}
              title={`Filter to tag: ${tag}`}
            >
              {tag}
            </button>
          ))}
          {(filterMode !== "all" || filterTag !== null) && (
            <button
              type="button"
              className="cos-task-filter-clear"
              onClick={() => {
                onFilterMode("all");
                onFilterTag(null);
              }}
            >
              clear
            </button>
          )}
        </div>
      )}
      {reviewing && (
        <div className="cos-newtask-status" role="status" aria-live="polite">
          Claude is doing the weekly review — wins, triage, project health,
          next-week preview. 2-4 minutes typical. Safe to navigate away.
        </div>
      )}
      {reviewError && (
        <div className="cos-newtask-error">
          Weekly review failed: {reviewError}
          <button
            type="button"
            className="cos-btn cos-btn-ghost"
            onClick={() => dismissRun("weekly-review")}
            style={{ marginLeft: 8 }}
          >
            dismiss
          </button>
        </div>
      )}
      {triaging && (
        <div className="cos-newtask-status" role="status" aria-live="polite">
          Claude is reviewing every active task — safe to navigate away…
        </div>
      )}
      {triageError && (
        <div className="cos-newtask-error">
          Triage failed: {triageError}
          <button
            type="button"
            className="cos-btn cos-btn-ghost"
            onClick={() => dismissRun("task-triage")}
            style={{ marginLeft: 8 }}
          >
            dismiss
          </button>
        </div>
      )}

      {load.kind === "loading" && <div className="cos-empty">Loading tasks…</div>}

      {load.kind === "error" && (
        <div className="cos-empty cos-empty-error">
          Could not read tasks: {load.error}
        </div>
      )}

      {load.kind === "ok" && !load.status.found && (
        <div className="cos-empty">
          v1 database not found at{" "}
          <code className="cos-source-path">{load.status.path}</code>.
          <br />
          Set <code>COS_V1_DB=/path/to/cos.db</code> and relaunch, or run from
          the <code>work-agent</code> repo.
        </div>
      )}

      {load.kind === "ok" && load.status.found && buckets && (
        <>
          {load.tasks.length === 0 ? (
            <div className="cos-empty">Inbox zero. Nice.</div>
          ) : filtered.kind === "ok" && filtered.tasks.length === 0 ? (
            <div className="cos-empty">
              No tasks match this filter.
              {(filterMode !== "all" || filterTag !== null) && (
                <>
                  {" "}
                  <button
                    type="button"
                    className="cos-btn cos-btn-ghost"
                    onClick={() => {
                      onFilterMode("all");
                      onFilterTag(null);
                    }}
                  >
                    clear filter
                  </button>
                </>
              )}
            </div>
          ) : (
            <div className="cos-work-buckets">
              <BucketList
                label="Now"
                tone="overdue"
                shortcut="N"
                tasks={buckets.now}
                onSelect={onSelect}
                onComplete={onComplete}
                selectedId={selectedId}
                busyId={busyId}
                completingId={completingId}
                scrollToId={scrollToId}
                onScrollHandled={onScrollHandled}
                onTagClick={onTagClick}
                emptyLabel="Nothing overdue. Nothing due today."
              />
              <BucketList
                label="This week"
                tone="today"
                shortcut="W"
                tasks={buckets.thisWeek}
                onSelect={onSelect}
                onComplete={onComplete}
                selectedId={selectedId}
                busyId={busyId}
                completingId={completingId}
                scrollToId={scrollToId}
                onScrollHandled={onScrollHandled}
                onTagClick={onTagClick}
                emptyLabel="Nothing else due this week."
              />
              <BucketList
                label="Soon"
                tone="soon"
                shortcut="S"
                tasks={buckets.soon}
                onSelect={onSelect}
                onComplete={onComplete}
                selectedId={selectedId}
                busyId={busyId}
                completingId={completingId}
                scrollToId={scrollToId}
                onScrollHandled={onScrollHandled}
                onTagClick={onTagClick}
                emptyLabel="Nothing in the next 14 days."
              />
              <BucketList
                label="Someday"
                tone="someday"
                tasks={buckets.someday}
                onSelect={onSelect}
                onComplete={onComplete}
                selectedId={selectedId}
                busyId={busyId}
                completingId={completingId}
                scrollToId={scrollToId}
                onScrollHandled={onScrollHandled}
                onTagClick={onTagClick}
                emptyLabel="Nothing parked for someday."
              />
            </div>
          )}
        </>
      )}

    </>
  );
}

function NewTaskRow({
  onCreated,
}: {
  onCreated: (task: V1Task) => void;
}) {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (parseWithClaude: boolean) => {
    if (submitting || !text.trim()) return;
    setSubmitting(true);
    setError(null);
    const result = await createTaskFromText(text, parseWithClaude);
    setSubmitting(false);
    if (result.error || !result.task) {
      setError(result.error ?? "task creation failed");
      return;
    }
    setText("");
    onCreated(result.task);
  };

  return (
    <div className="cos-newtask">
      <div className={`cos-newtask-row ${submitting ? "is-busy" : ""}`}>
        <span className="cos-newtask-plus" aria-hidden>+</span>
        <input
          type="text"
          className="cos-newtask-input"
          placeholder='New task — "call bob tomorrow 2pm about budget"'
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
        {submitting && <span className="cos-newtask-spinner" aria-hidden />}
      </div>
      {error && <div className="cos-newtask-error">{error}</div>}
    </div>
  );
}

function BucketList({
  label,
  tone,
  shortcut,
  tasks,
  onSelect,
  onComplete,
  selectedId,
  busyId,
  completingId,
  scrollToId,
  onScrollHandled,
  onTagClick,
  emptyLabel,
  defaultCollapsed,
}: {
  label: string;
  tone: TimeBucketTone;
  shortcut?: string;
  tasks: V1Task[];
  onSelect: (task: V1Task | null) => void;
  onComplete: (task: V1Task) => void;
  selectedId: string | null;
  busyId: string | null;
  completingId: string | null;
  scrollToId: string | null;
  onScrollHandled: () => void;
  onTagClick?: (tag: string) => void;
  emptyLabel: string;
  defaultCollapsed?: boolean;
}) {
  const containsScrollTarget = scrollToId
    ? tasks.some((t) => t.id === scrollToId)
    : false;

  return (
    <TimeBucket
      label={label}
      tone={tone}
      shortcut={shortcut}
      count={tasks.length}
      defaultCollapsed={defaultCollapsed}
      forceExpand={containsScrollTarget}
      emptyLabel={emptyLabel}
    >
      {tasks.length === 0 ? null : (
        <ul className="cos-task-list" role="list">
          {tasks.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              selected={t.id === selectedId}
              busy={busyId === t.id}
              completing={completingId === t.id}
              onSelect={() => onSelect(t.id === selectedId ? null : t)}
              onComplete={() => onComplete(t)}
              scrollIntoView={scrollToId === t.id}
              onScrolled={onScrollHandled}
              onTagClick={onTagClick}
            />
          ))}
        </ul>
      )}
    </TimeBucket>
  );
}

function TaskRow({
  task,
  selected,
  busy,
  completing,
  onSelect,
  onComplete,
  scrollIntoView,
  onScrolled,
  onTagClick,
}: {
  task: V1Task;
  selected: boolean;
  busy: boolean;
  completing: boolean;
  onSelect: () => void;
  onComplete: () => void;
  scrollIntoView: boolean;
  onScrolled: () => void;
  onTagClick?: (tag: string) => void;
}) {
  const ref = useRef<HTMLLIElement | null>(null);
  const due = task.due ? dueSignal(task.due) : null;

  useEffect(() => {
    if (scrollIntoView && ref.current) {
      const node = ref.current;
      node.scrollIntoView({ behavior: "smooth", block: "center" });
      // Flash the row so the user's eye tracks it. Clearing after the
      // animation duration keeps re-renders from re-triggering the flash.
      node.classList.add("is-just-created");
      const timer = window.setTimeout(() => {
        node.classList.remove("is-just-created");
        onScrolled();
      }, 1600);
      return () => {
        window.clearTimeout(timer);
        // Drop the flash class on early teardown (surface change while
        // the animation is still playing) so navigating back doesn't
        // find the row mid-flash.
        node.classList.remove("is-just-created");
      };
    }
  }, [scrollIntoView, onScrolled]);

  return (
    <li
      ref={ref}
      className={`cos-task-row ${selected ? "is-selected" : ""} ${
        busy ? "is-busy" : ""
      } ${completing ? "is-completing" : ""}`}
      aria-current={scrollIntoView ? "location" : undefined}
      onClick={onSelect}
    >
      <input
        type="checkbox"
        className="cos-task-check"
        aria-label={`Mark "${task.title}" done`}
        checked={false}
        disabled={busy}
        onChange={(e) => {
          e.stopPropagation();
          onComplete();
        }}
        onClick={(e) => e.stopPropagation()}
      />
      <span className={`cos-prio cos-prio-${task.priority}`} title={task.priority}>
        {task.priority[0].toUpperCase()}
      </span>
      <div className="cos-task-title">
        <span>{task.title}</span>
        {task.project && <span className="cos-task-project">{task.project}</span>}
      </div>
      <div className="cos-task-meta">
        {task.tags.slice(0, 3).map((tag) => (
          <button
            key={tag}
            type="button"
            className="cos-chip cos-chip-clickable"
            title={`Filter to tag: ${tag}`}
            onClick={(e) => {
              e.stopPropagation();
              onTagClick?.(tag);
            }}
          >
            {tag}
          </button>
        ))}
        {task.tags.length > 3 && (
          <span className="cos-chip cos-chip-muted">
            +{task.tags.length - 3}
          </span>
        )}
        {task.links.length > 0 && (
          <span className="cos-link-marker" title={`${task.links.length} link(s)`}>
            <ExternalLink size={12} aria-hidden />
          </span>
        )}
      </div>
      <div
        className={`cos-task-due ${due ? `cos-task-due-${due.tone}` : ""}`}
        title={task.due ?? ""}
      >
        {due?.label ?? "—"}
      </div>
    </li>
  );
}

function today(): string {
  // Local-timezone YYYY-MM-DD so "due < today" doesn't mis-classify
  // tasks past local 7 PM in negative-offset zones.
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Human-readable relative due-date with a tone for color-coding.
 *  "today" / "in 3d" / "2d ago" / "3w ago". Tone tracks dueSignal so
 *  the colorways match the row chips elsewhere on Tasks. */
export function relativeDue(due: string): {
  label: string;
  tone: "overdue" | "soon" | "later";
} {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(due);
  if (!m) return { label: due, tone: "later" };
  const [year, month, day] = m[1].split("-").map(Number);
  const target = new Date(year, month - 1, day);
  target.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round(
    (target.getTime() - today.getTime()) / 86_400_000,
  );
  if (days === 0) return { label: "today", tone: "soon" };
  if (days === 1) return { label: "tomorrow", tone: "soon" };
  if (days === -1) return { label: "yesterday", tone: "overdue" };
  if (days > 0) {
    if (days < 14) return { label: `in ${days}d`, tone: days <= 3 ? "soon" : "later" };
    if (days < 60) return { label: `in ${Math.round(days / 7)}w`, tone: "later" };
    return { label: `in ${Math.round(days / 30)}mo`, tone: "later" };
  }
  const ago = -days;
  if (ago < 14) return { label: `${ago}d ago`, tone: "overdue" };
  if (ago < 60) return { label: `${Math.round(ago / 7)}w ago`, tone: "overdue" };
  return { label: `${Math.round(ago / 30)}mo ago`, tone: "overdue" };
}

/** Compute the new due-date string after snoozing N days from the
 *  task's current due (or from today, when no due is set). Output
 *  matches the format DueField round-trips (YYYY-MM-DD or
 *  YYYY-MM-DD HH:mm if the original had a time). Pure so it's
 *  unit-testable. */
export function snoozeDue(current: string | null, days: number): string {
  // Anchor: parse current if it looks valid, else today (local).
  let base: Date;
  let hasTime = false;
  if (current) {
    const m = /^(\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}))?$/.exec(current);
    if (m) {
      const [year, month, day] = m[1].split("-").map(Number);
      base = new Date(year, month - 1, day);
      if (m[2]) {
        const [h, mn] = m[2].split(":").map(Number);
        base.setHours(h, mn, 0, 0);
        hasTime = true;
      }
    } else {
      base = new Date();
    }
  } else {
    base = new Date();
    base.setHours(0, 0, 0, 0);
  }
  base.setDate(base.getDate() + days);
  const yyyy = base.getFullYear();
  const mm = String(base.getMonth() + 1).padStart(2, "0");
  const dd = String(base.getDate()).padStart(2, "0");
  if (hasTime) {
    const hh = String(base.getHours()).padStart(2, "0");
    const min = String(base.getMinutes()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
  }
  return `${yyyy}-${mm}-${dd}`;
}

function dueSignal(due: string): { label: string; tone: "overdue" | "soon" | "later" } {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const dueDate = new Date(due);
  dueDate.setHours(0, 0, 0, 0);
  const days = Math.round((dueDate.getTime() - now.getTime()) / 86_400_000);
  if (days < 0) return { label: `${Math.abs(days)}d overdue`, tone: "overdue" };
  if (days === 0) return { label: "today", tone: "soon" };
  if (days === 1) return { label: "tomorrow", tone: "soon" };
  if (days <= 7) return { label: `${days}d`, tone: "soon" };
  return { label: due, tone: "later" };
}

/** A task is overdue when its due date is strictly before today's local
 * date. "Due today" is not overdue. Time-of-day is ignored. */
export function isOverdue(task: V1Task): boolean {
  if (!task.due) return false;
  return task.due.slice(0, 10) < today();
}

export type BucketedTasks = {
  now: V1Task[];
  thisWeek: V1Task[];
  soon: V1Task[];
  someday: V1Task[];
};

/** PRD-115 §6.2 — split active tasks into Now / This week / Soon / Someday.
 *  - Now: overdue + due today (time-specific tasks pinned to top by due time)
 *  - This week: due within the next 7 days
 *  - Soon: due in days 8–14
 *  - Someday: everything else (further out OR no due date)
 *
 *  Within each bucket, the existing v1_tasks_list ordering (priority + due)
 *  is preserved. Time-specific Now tasks come first because their due strings
 *  include "HH:MM" and lexicographic ordering of YYYY-MM-DD HH:MM is correct.
 */
export function bucketTasks(tasks: V1Task[]): BucketedTasks {
  const todayStr = today();
  const now: V1Task[] = [];
  const thisWeek: V1Task[] = [];
  const soon: V1Task[] = [];
  const someday: V1Task[] = [];

  // Compute bucket boundaries once (local-midnight YYYY-MM-DD strings).
  const plus = (days: number): string => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + days);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const week = plus(7);
  const fortnight = plus(14);

  for (const t of tasks) {
    if (t.status === "done") continue;
    if (!t.due) {
      someday.push(t);
      continue;
    }
    const dueDay = t.due.slice(0, 10);
    if (dueDay <= todayStr) {
      now.push(t);
    } else if (dueDay <= week) {
      thisWeek.push(t);
    } else if (dueDay <= fortnight) {
      soon.push(t);
    } else {
      someday.push(t);
    }
  }

  // Pin time-specific tasks to the top of Now: those whose due includes
  // a time component (length > 10) sort before pure-date tasks within
  // the same day. Within each subgroup, lexicographic on the due string
  // is correct (PRD-004 §3 — local-time YYYY-MM-DD HH:MM).
  now.sort((a, b) => {
    const aTimed = (a.due ?? "").length > 10;
    const bTimed = (b.due ?? "").length > 10;
    if (aTimed !== bTimed) return aTimed ? -1 : 1;
    return (a.due ?? "").localeCompare(b.due ?? "");
  });

  return { now, thisWeek, soon, someday };
}

type SaveState = "idle" | "saving" | "saved" | "error";

type TaskPatch = Partial<{
  title: string;
  priority: "high" | "medium" | "low";
  due: string | null;
  project: string | null;
  notes: string | null;
  tags: string[];
}>;

export function TaskDetailPanel({
  task,
  onUpdated,
  onComplete,
}: {
  task: V1Task | null;
  onUpdated: (fresh: V1Task) => void;
  onComplete: (task: V1Task) => void;
}) {
  const [save, setSave] = useState<{ state: SaveState; error?: string }>({
    state: "idle",
  });
  const [newTag, setNewTag] = useState("");
  const [projects, setProjects] = useState<string[]>([]);
  const savedTimer = useRef<number | null>(null);

  // Load project slugs once — the list is small and stable per session.
  useEffect(() => {
    invoke<string[]>("content_list_projects")
      .then(setProjects)
      .catch(() => setProjects([]));
  }, []);

  // Clear any pending "saved ✓" fade-out when the selected task changes.
  useEffect(() => {
    setSave({ state: "idle" });
    setNewTag("");
    if (savedTimer.current != null) {
      window.clearTimeout(savedTimer.current);
      savedTimer.current = null;
    }
  }, [task?.id]);

  const submit = useCallback(
    async (patch: TaskPatch) => {
      if (!task) return;
      setSave({ state: "saving" });
      try {
        const fresh = await invoke<V1Task>("v1_tasks_update", {
          id: task.id,
          patch,
        });
        onUpdated(fresh);
        setSave({ state: "saved" });
        if (savedTimer.current != null) window.clearTimeout(savedTimer.current);
        savedTimer.current = window.setTimeout(
          () => setSave({ state: "idle" }),
          1800,
        );
      } catch (error) {
        setSave({ state: "error", error: String(error) });
      }
    },
    [task, onUpdated],
  );

  if (!task) {
    return (
      <div className="cos-detail-empty">
        Select a task to see its notes, tags, and links here.
      </div>
    );
  }

  const addTag = () => {
    const next = newTag.trim();
    if (!next) return;
    if (task.tags.includes(next)) {
      setNewTag("");
      return;
    }
    submit({ tags: [...task.tags, next] });
    setNewTag("");
  };

  const removeTag = (tag: string) => {
    submit({ tags: task.tags.filter((t) => t !== tag) });
  };

  return (
    <div className="cos-detail">
      <div className="cos-detail-head">
        <PriorityPicker
          value={task.priority}
          onChange={(priority) => {
            if (priority !== task.priority) submit({ priority });
          }}
        />
        <TitleField
          key={task.id}
          initial={task.title}
          onCommit={(title) => {
            if (title !== task.title) submit({ title });
          }}
        />
        <SaveIndicator save={save} />
      </div>

      <dl className="cos-detail-meta">
        <dt>Due</dt>
        <dd>
          <DueField
            key={`${task.id}-${task.due ?? ""}`}
            value={task.due}
            onCommit={(due) => {
              const normalized = due === "" ? null : due;
              if (normalized !== (task.due ?? null)) submit({ due: normalized });
            }}
          />
          {task.due && (
            <span
              className={`cos-detail-due-rel cos-detail-due-rel-${
                relativeDue(task.due).tone
              }`}
              title={task.due}
            >
              {relativeDue(task.due).label}
            </span>
          )}
          <div className="cos-detail-snooze" aria-label="Snooze">
            <button
              type="button"
              className="cos-btn cos-btn-ghost"
              onClick={() => submit({ due: snoozeDue(task.due, 1) })}
              title="Push due date forward by 1 day"
            >
              +1d
            </button>
            <button
              type="button"
              className="cos-btn cos-btn-ghost"
              onClick={() => submit({ due: snoozeDue(task.due, 7) })}
              title="Push due date forward by 1 week"
            >
              +1w
            </button>
            <button
              type="button"
              className="cos-btn cos-btn-ghost"
              onClick={() => submit({ due: snoozeDue(task.due, 30) })}
              title="Push due date forward by 1 month"
            >
              +1mo
            </button>
          </div>
        </dd>

        <dt>Project</dt>
        <dd>
          <ProjectPicker
            value={task.project}
            options={projects}
            onChange={(next) => {
              if (next !== (task.project ?? null)) submit({ project: next });
            }}
          />
        </dd>

        <dt>Tags</dt>
        <dd>
          <div className="cos-tag-field">
            {task.tags.map((t) => (
              <span key={t} className="cos-chip cos-chip-removable">
                {t}
                <button
                  type="button"
                  aria-label={`Remove tag ${t}`}
                  className="cos-chip-x"
                  onClick={() => removeTag(t)}
                >
                  ×
                </button>
              </span>
            ))}
            <input
              type="text"
              className="cos-tag-input"
              placeholder="+ tag"
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addTag();
                } else if (e.key === "Escape") {
                  setNewTag("");
                }
              }}
              onBlur={addTag}
            />
          </div>
        </dd>

        <dt>ID</dt>
        <dd>
          <code>{task.id}</code>
        </dd>
        {task.updated_at && (
          <>
            <dt>Updated</dt>
            <dd
              className="cos-detail-muted"
              title={task.updated_at}
            >
              {humanTimestamp(task.updated_at)}
            </dd>
          </>
        )}
      </dl>

      <div className="cos-detail-notes">
        <NotesField
          key={`${task.id}-notes-${task.notes ?? ""}`}
          initial={task.notes ?? ""}
          onCommit={(next) => {
            const normalized = next.trim() === "" ? null : next;
            if (normalized !== (task.notes ?? null))
              submit({ notes: normalized });
          }}
        />
      </div>

      {task.links.length > 0 && (
        <div className="cos-detail-links">
          <h3>Links</h3>
          <ul>
            {task.links.map((url) => (
              <li key={url}>
                <a href={url} target="_blank" rel="noreferrer">
                  {url}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="cos-detail-actions">
        <button
          type="button"
          className="cos-btn cos-btn-done"
          onClick={() => onComplete(task)}
          disabled={save.state === "saving"}
        >
          ✓ Mark done
        </button>
      </div>
    </div>
  );
}

function SaveIndicator({
  save,
}: {
  save: { state: SaveState; error?: string };
}) {
  if (save.state === "idle") return null;
  if (save.state === "saving")
    return <span className="cos-save-pill">saving…</span>;
  if (save.state === "saved")
    return <span className="cos-save-pill cos-save-pill-ok">saved ✓</span>;
  return (
    <span className="cos-save-pill cos-save-pill-err" title={save.error}>
      save failed
    </span>
  );
}

function PriorityPicker({
  value,
  onChange,
}: {
  value: V1Task["priority"];
  onChange: (next: V1Task["priority"]) => void;
}) {
  const options: V1Task["priority"][] = ["high", "medium", "low"];
  return (
    <div className="cos-prio-picker" role="radiogroup" aria-label="Priority">
      {options.map((p) => (
        <button
          key={p}
          type="button"
          role="radio"
          aria-checked={value === p}
          className={`cos-prio cos-prio-${p} ${
            value === p ? "is-active" : "is-muted"
          }`}
          title={p}
          onClick={() => onChange(p)}
        >
          {p[0].toUpperCase()}
        </button>
      ))}
    </div>
  );
}

function TitleField({
  initial,
  onCommit,
}: {
  initial: string;
  onCommit: (next: string) => void;
}) {
  const [val, setVal] = useState(initial);
  return (
    <input
      type="text"
      className="cos-title-input"
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onBlur={() => {
        const trimmed = val.trim();
        if (trimmed.length === 0) {
          setVal(initial);
          return;
        }
        onCommit(trimmed);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
          setVal(initial);
          (e.target as HTMLInputElement).blur();
        }
      }}
      aria-label="Task title"
    />
  );
}

function DueField({
  value,
  onCommit,
}: {
  value: string | null;
  onCommit: (next: string) => void;
}) {
  // v1 stores `due` as either "YYYY-MM-DD" (all-day) or "YYYY-MM-DD HH:MM".
  // datetime-local expects "YYYY-MM-DDTHH:MM"; bridge the two formats below.
  const initial = toDatetimeLocal(value ?? "");
  const [val, setVal] = useState(initial);

  const commit = (next: string) => {
    if (next === "") {
      onCommit("");
      return;
    }
    // datetime-local strips seconds; convert "T" → " " for v1's shape.
    onCommit(next.replace("T", " "));
  };

  return (
    <div className="cos-date-field">
      <input
        type="datetime-local"
        className="cos-date-input"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={() => commit(val)}
      />
      {val && (
        <button
          type="button"
          className="cos-field-clear"
          aria-label="Clear due date"
          onClick={() => {
            setVal("");
            commit("");
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

function toDatetimeLocal(due: string): string {
  if (!due) return "";
  if (due.length === 10) return `${due}T09:00`; // Default to 9 AM when promoting a date-only to datetime.
  return due.replace(" ", "T");
}

function ProjectPicker({
  value,
  options,
  onChange,
}: {
  value: string | null;
  options: string[];
  onChange: (next: string | null) => void;
}) {
  // If the task's project isn't in the options list (stale, archived, or
  // not under data/files/projects/), surface it anyway so the user can
  // still see it and pick a new value.
  const augmented = value && !options.includes(value)
    ? [value, ...options]
    : options;
  return (
    <select
      className="cos-project-select"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
    >
      <option value="">(none)</option>
      {augmented.map((slug) => (
        <option key={slug} value={slug}>
          {slug}
        </option>
      ))}
    </select>
  );
}

function humanTimestamp(iso: string): string {
  // v1's updated_at is "2026-04-24T09:30:45.123Z" (UTC). Render in the local
  // timezone, tight format. Falls back to the raw string if parsing fails.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const diffMin = Math.round((now.getTime() - d.getTime()) / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const sameYear = d.getFullYear() === now.getFullYear();
  const fmt: Intl.DateTimeFormatOptions = sameYear
    ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
    : {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      };
  return d.toLocaleString(undefined, fmt);
}

function NotesField({
  initial,
  onCommit,
}: {
  initial: string;
  onCommit: (next: string) => void;
}) {
  const [val, setVal] = useState(initial);
  const [editing, setEditing] = useState(initial.length === 0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-focus when transitioning into edit mode (click on read-mode
  // preview should land the cursor in the textarea immediately).
  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [editing]);

  if (!editing) {
    return (
      <button
        type="button"
        className="cos-notes-preview"
        onClick={() => setEditing(true)}
        title="Click to edit"
      >
        {val.trim().length === 0 ? (
          <span className="cos-notes-preview-empty">
            No notes — click to add.
          </span>
        ) : (
          <BlockMarkdown text={val} />
        )}
      </button>
    );
  }

  return (
    <textarea
      ref={textareaRef}
      className="cos-notes-input"
      rows={8}
      value={val}
      placeholder="Notes — markdown supported."
      onChange={(e) => setVal(e.target.value)}
      onBlur={() => {
        onCommit(val);
        // Drop back into preview mode unless the field is empty (no
        // point flipping to a "click to edit" affordance for nothing).
        if (val.trim().length > 0) setEditing(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setVal(initial);
          (e.target as HTMLTextAreaElement).blur();
          setEditing(initial.trim().length === 0);
        }
      }}
      aria-label="Task notes"
    />
  );
}
