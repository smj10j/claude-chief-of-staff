import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  CalendarClock,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Clock,
  FileText,
  MessageSquare,
} from "lucide-react";

import {
  findPrepTarget,
  openPrepTarget,
  type PrepTarget,
} from "../state/calendarPrep";
import { InlineMarkdown } from "../state/inlineMarkdown";
import { type OpenDoc } from "../state/openDoc";
import {
  RECENT_CHANGED_EVENT,
  decorateRecentLabel,
  readRecent,
  type RecentDoc,
} from "../state/recentDocs";
import { dismissRun, runSkill, useRun } from "../state/skillRuns";
import { SectionHeader, SurfaceHero } from "../ui";
import { openUrl } from "@tauri-apps/plugin-opener";
import { type CalendarEvent } from "./Calendar";
import { type MeetingTarget } from "./MeetingDetail";
import { type ProfileTarget } from "./PersonProfile";

type ReminderItem = {
  id: string;
  name: string;
  due_date?: string | null;
  notes?: string | null;
};

type RemindersResult = {
  available: boolean;
  items: ReminderItem[];
  error: string | null;
};

type SessionMeta = { date: string; rel_path: string };

type SessionRef = {
  rel_path: string;
  owner_kind: string;
  owner_slug: string;
  owner_label: string;
  date: string;
};

type ContentStatus = {
  root: string;
  found: boolean;
};

type PriorityItem = {
  text: string;
  source: "briefing" | "overdue" | "placeholder";
  rel_path?: string | null;
  task_id?: string | null;
  scroll_to?: string | null;
};

type PendingDoc = {
  rel_path: string;
  label: string;
  context: string;
  pending_count: number;
  latest_comment: string;
};

type Props = {
  onOpenDoc: (doc: OpenDoc) => void;
  /** Open the Work surface and select the given task id. Used by
   *  priority cards whose bullet matched a task. */
  onGoToTask: (id: string) => void;
  onGoToMeeting: (target: MeetingTarget) => void;
  onGoToProfile: (target: ProfileTarget) => void;
};

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function Home({ onOpenDoc, onGoToTask, onGoToMeeting, onGoToProfile }: Props) {
  const [briefings, setBriefings] = useState<SessionMeta[]>([]);
  const [briefingsErr, setBriefingsErr] = useState<string | null>(null);
  const [reminders, setReminders] = useState<RemindersResult | null>(null);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [pending, setPending] = useState<PendingDoc[]>([]);
  const [priorities, setPriorities] = useState<PriorityItem[]>([]);
  const [recentSessions, setRecentSessions] = useState<SessionRef[]>([]);
  const [recentDocs, setRecentDocs] = useState<RecentDoc[]>(() => readRecent());
  const [remindersOpen, setRemindersOpen] = useState(false);
  const [annotationsOpen, setAnnotationsOpen] = useState(false);
  const [contentStatus, setContentStatus] = useState<ContentStatus | null>(
    null,
  );

  const briefingRun = useRun("morning-briefing");
  const briefing =
    briefingRun?.state === "running"
      ? "running"
      : briefingRun?.state === "error"
        ? "error"
        : "idle";
  const briefingError =
    briefingRun?.state === "error" ? (briefingRun.error ?? null) : null;
  const lastOpenedGen = useRef(0);

  const todayDate = useMemo(() => localDateString(), []);
  const greeting = useMemo(() => greetingForToday(), []);
  const todayBriefing = briefings.find((b) => b.date === todayDate);

  const runMorningBriefing = () => {
    if (briefing === "running") return;
    runSkill("morning-briefing", "Brief me", async () => {
      const result = await invoke<{ rel_path: string; summary: string }>(
        "morning_briefing",
      );
      onOpenDoc({
        relPath: result.rel_path,
        label:
          result.rel_path.split("/").pop()?.replace(/\.md$/, "") ?? "briefing",
      });
      lastOpenedGen.current = (briefingRun?.generation ?? 0) + 1;
      return result;
    }).catch(() => {
      /* error captured in run state */
    });
  };

  const loadBriefings = useCallback(async () => {
    try {
      const list = await invoke<SessionMeta[]>("content_recent_briefings", {
        limit: 7,
      });
      setBriefings(list);
      setBriefingsErr(null);
    } catch (error) {
      setBriefingsErr(String(error));
    }
  }, []);

  const loadPriorities = useCallback(async () => {
    try {
      const list = await invoke<PriorityItem[]>("content_top_priorities", {
        today: todayDate,
        limit: 3,
      });
      setPriorities(list);
    } catch {
      setPriorities([]);
    }
  }, [todayDate]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await invoke<ContentStatus>("content_status");
        if (!cancelled) setContentStatus(status);
      } catch {
        // Non-fatal — Home still renders.
      }
      if (!cancelled) loadBriefings();
      if (!cancelled) loadPriorities();
      try {
        const sessions = await invoke<SessionRef[]>(
          "content_recent_sessions",
          { limit: 3 },
        );
        if (!cancelled) setRecentSessions(sessions);
      } catch {
        if (!cancelled) setRecentSessions([]);
      }
      try {
        const list = await invoke<RemindersResult>("reminders_list");
        if (!cancelled) setReminders(list);
      } catch {
        if (!cancelled) {
          setReminders({ available: false, items: [], error: null });
        }
      }
      try {
        const list = await invoke<CalendarEvent[]>("calendar_events", {
          from: todayDate,
          to: todayDate,
        });
        if (!cancelled) setEvents(list);
      } catch {
        if (!cancelled) setEvents([]);
      }
      try {
        const docs = await invoke<PendingDoc[]>("annotations_list_pending");
        if (!cancelled) setPending(docs);
      } catch {
        if (!cancelled) setPending([]);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // MRU strip subscribes to the recent-docs event so the strip refreshes
  // without a full Home reload when the user opens a doc anywhere else.
  useEffect(() => {
    const onChange = () => setRecentDocs(readRecent());
    window.addEventListener(RECENT_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(RECENT_CHANGED_EVENT, onChange);
  }, []);

  // After a successful Brief me run, refresh briefings + priorities so
  // the new content surfaces immediately.
  const briefingGen = briefingRun?.generation ?? 0;
  useEffect(() => {
    if (briefingGen === 0) return;
    loadBriefings();
    loadPriorities();
  }, [briefingGen, loadBriefings, loadPriorities]);

  const briefingsRel = briefings.slice(0, 7);
  const agendaEvents = useMemo(
    () =>
      events
        .filter((e) => e.status !== "cancelled")
        .slice()
        .sort((a, b) => a.start.localeCompare(b.start)),
    [events],
  );

  const remindersCount =
    reminders?.available && reminders.items.length > 0
      ? reminders.items.length
      : 0;
  const annotationsCount = pending.reduce(
    (sum, d) => sum + d.pending_count,
    0,
  );
  const inboxHasAnything = remindersCount > 0 || annotationsCount > 0;

  return (
    <div className="cos-home cos-home-redesigned">
      <SurfaceHero
        title={greeting}
        subtitle={
          briefing === "running"
            ? "Briefing in progress — calendar, tasks, signals."
            : todayBriefing
              ? "Today's briefing is ready below."
              : "Click Brief me to pull today's calendar, tasks, and signals."
        }
        actions={
          <button
            type="button"
            className="cos-btn cos-btn-primary"
            onClick={runMorningBriefing}
            disabled={briefing === "running"}
            title={
              todayBriefing
                ? "Re-run /morning-briefing — overwrites today's briefing"
                : "Run /morning-briefing — pulls calendar + tasks + signals into a dated briefing file"
            }
          >
            {briefing === "running" ? (
              <>
                <span className="cos-newtask-spinner" aria-hidden />
                briefing…
              </>
            ) : todayBriefing ? (
              "Re-brief"
            ) : (
              "Brief me"
            )}
          </button>
        }
      />

      {briefing === "running" && (
        <div className="cos-running-hint" style={{ marginBottom: 16 }}>
          <span className="cos-newtask-spinner" aria-hidden />
          {" "}Working on your briefing — usually takes 3–10 minutes
          while Claude pulls calendar, tasks, Slack, Jira, GitHub, and
          past sessions. Feel free to keep working in another tab; the
          briefing will land here when it's done and a notification
          will fire.
        </div>
      )}

      {briefing === "error" && (
        <div className="cos-newtask-error" style={{ marginBottom: 16 }}>
          Briefing failed: {briefingError}
          <button
            type="button"
            className="cos-btn cos-btn-ghost"
            onClick={() => dismissRun("morning-briefing")}
            style={{ marginLeft: 8 }}
          >
            dismiss
          </button>
        </div>
      )}

      {priorities.length > 0 && (
        <section
          className="cos-home-priorities"
          aria-label={`Top ${priorities.length} priorities today`}
        >
          {priorities.map((p, i) => (
            <PriorityCard
              key={`${p.source}-${i}`}
              index={i + 1}
              item={p}
              onOpen={() => {
                // Backend resolves the priority into one of three
                // routings — task, doc-with-scroll, or briefing
                // fallback — and only sets the field that matches.
                if (p.task_id) {
                  onGoToTask(p.task_id);
                  return;
                }
                if (p.rel_path) {
                  onOpenDoc({
                    relPath: p.rel_path,
                    label: p.rel_path.split("/").pop() ?? "briefing",
                    scrollTo: p.scroll_to ?? undefined,
                  });
                }
              }}
            />
          ))}
        </section>
      )}

      <section className="cos-home-briefings-line" aria-label="Recent briefings">
        {briefingsErr ? (
          <span className="cos-home-briefings-error">
            Could not list briefings: {briefingsErr}
          </span>
        ) : briefingsRel.length === 0 ? (
          <span className="cos-home-briefings-empty">
            No briefings yet. Use <strong>Brief me</strong> above to create
            today's.
          </span>
        ) : (
          <>
            <span className="cos-home-briefings-label">Briefings</span>
            <ul className="cos-home-briefings-chips">
              {briefingsRel.map((b) => (
                <li key={b.rel_path}>
                  <button
                    type="button"
                    className={`cos-home-briefings-chip${
                      b.date === todayDate ? " is-today" : ""
                    }`}
                    onClick={() =>
                      onOpenDoc({
                        relPath: b.rel_path,
                        label: b.date,
                      })
                    }
                    title={`Open ${b.date}`}
                  >
                    {b.date === todayDate ? "Today" : briefingRelative(b.date)}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {agendaEvents.length > 0 && (
        <section className="cos-home-calendar" aria-label="Today's calendar">
          <ul className="cos-home-agenda" role="list">
            {agendaEvents.map((e) => (
              <HomeAgendaRow
                key={`${e.uid}-${e.start}`}
                event={e}
                onOpenDoc={onOpenDoc}
                onGoToMeeting={onGoToMeeting}
                onGoToProfile={onGoToProfile}
              />
            ))}
          </ul>
        </section>
      )}

      <div className="cos-home-sweep">
        <button
          type="button"
          className="cos-btn cos-btn-ghost"
          onClick={() => {
            window.dispatchEvent(new CustomEvent("cos:morning-sweep"));
            // Toast is fired by the surfaces that listen.
          }}
          title="Refresh every Ops + Velocity + Roadmap snapshot"
        >
          ↻ Morning sweep
        </button>
      </div>

      <HomeStrips />

      {recentSessions.length > 0 && contentStatus?.found && (
        <section className="cos-home-prep" aria-label="Recent prep docs">
          <SectionHeader
            label="Recent prep"
            count={recentSessions.length}
          />
          <div className="cos-home-prep-grid">
            {recentSessions.map((s) => (
              <button
                key={s.rel_path}
                type="button"
                className="cos-home-prep-card"
                onClick={() =>
                  onOpenDoc({
                    relPath: s.rel_path,
                    label: s.date,
                    crumbs: [{ label: s.owner_label }],
                  })
                }
              >
                <div className="cos-home-prep-card-head">
                  <CalendarClock size={14} strokeWidth={1.75} aria-hidden />
                  <span className="cos-home-prep-card-owner">
                    {s.owner_label}
                  </span>
                </div>
                <div className="cos-home-prep-card-meta">
                  <span className="cos-home-prep-card-kind">
                    {s.owner_kind}
                  </span>
                  <span className="cos-home-prep-card-date">{s.date}</span>
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      {inboxHasAnything && (
        <section className="cos-home-inbox" aria-label="Inbox">
          <div className="cos-home-inbox-strip">
            {remindersCount > 0 && (
              <button
                type="button"
                className={`cos-home-inbox-chip${
                  remindersOpen ? " is-open" : ""
                }`}
                aria-expanded={remindersOpen}
                onClick={() => setRemindersOpen((v) => !v)}
                title="Pending Apple Reminders. Run /review-reminders in Claude Code to import."
              >
                {remindersOpen ? (
                  <ChevronDown size={14} strokeWidth={1.75} aria-hidden />
                ) : (
                  <ChevronRight size={14} strokeWidth={1.75} aria-hidden />
                )}
                <CheckSquare size={14} strokeWidth={1.75} aria-hidden />
                <span>
                  {remindersCount}{" "}
                  mobile capture{remindersCount === 1 ? "" : "s"}
                </span>
              </button>
            )}
            {annotationsCount > 0 && (
              <button
                type="button"
                className={`cos-home-inbox-chip${
                  annotationsOpen ? " is-open" : ""
                }`}
                aria-expanded={annotationsOpen}
                onClick={() => setAnnotationsOpen((v) => !v)}
                title="Notes you left for Claude that haven't been processed yet."
              >
                {annotationsOpen ? (
                  <ChevronDown size={14} strokeWidth={1.75} aria-hidden />
                ) : (
                  <ChevronRight size={14} strokeWidth={1.75} aria-hidden />
                )}
                <MessageSquare size={14} strokeWidth={1.75} aria-hidden />
                <span>
                  {annotationsCount}{" "}
                  pending annotation{annotationsCount === 1 ? "" : "s"}
                </span>
              </button>
            )}
          </div>
          {remindersOpen && reminders?.available && reminders.items.length > 0 && (
            <div className="cos-home-inbox-detail">
              <p className="cos-home-inbox-lede">
                Read-only — to import as tasks, run{" "}
                <code>/review-reminders</code> in Claude Code.
              </p>
              <ul className="cos-home-inbox-list">
                {reminders.items.slice(0, 8).map((r) => (
                  <li key={r.id} className="cos-home-inbox-item">
                    <CheckSquare size={14} strokeWidth={1.75} aria-hidden />
                    <span className="cos-home-inbox-item-label">{r.name}</span>
                    {r.notes && (
                      <span className="cos-home-inbox-item-meta">{r.notes}</span>
                    )}
                    {r.due_date && (
                      <span className="cos-home-inbox-item-date">
                        {r.due_date}
                      </span>
                    )}
                  </li>
                ))}
                {reminders.items.length > 8 && (
                  <li className="cos-home-inbox-overflow">
                    …and {reminders.items.length - 8} more
                  </li>
                )}
              </ul>
            </div>
          )}
          {annotationsOpen && pending.length > 0 && (
            <div className="cos-home-inbox-detail">
              <p className="cos-home-inbox-lede">
                Click to open the doc, then "Process N annotations" in the
                editor toolbar.
              </p>
              <ul className="cos-home-inbox-list">
                {pending.slice(0, 8).map((d) => (
                  <li key={d.rel_path}>
                    <button
                      type="button"
                      className="cos-home-inbox-item is-clickable"
                      onClick={() =>
                        onOpenDoc({
                          relPath: d.rel_path,
                          label: d.label,
                        })
                      }
                    >
                      <MessageSquare
                        size={14}
                        strokeWidth={1.75}
                        aria-hidden
                      />
                      <span className="cos-home-inbox-item-label">
                        {d.label}
                      </span>
                      <span className="cos-home-inbox-item-meta">
                        {d.context || "—"} · {d.latest_comment}
                      </span>
                      <span className="cos-home-inbox-item-date">
                        {d.pending_count}{" "}
                        {d.pending_count === 1 ? "note" : "notes"}
                      </span>
                    </button>
                  </li>
                ))}
                {pending.length > 8 && (
                  <li className="cos-home-inbox-overflow">
                    …and {pending.length - 8} more
                  </li>
                )}
              </ul>
            </div>
          )}
        </section>
      )}

      {recentDocs.length > 0 && (
        <section className="cos-home-recent" aria-label="Recently opened">
          <SectionHeader label="Recently opened" count={recentDocs.length} />
          <ul className="cos-recent-strip">
            {recentDocs.map((d) => (
              <li key={d.relPath}>
                <button
                  type="button"
                  className="cos-recent-chip"
                  onClick={() =>
                    onOpenDoc({ relPath: d.relPath, label: d.label })
                  }
                  title={d.relPath}
                >
                  <Clock size={12} strokeWidth={1.75} aria-hidden />
                  <span>{decorateRecentLabel(d.relPath, d.label)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {contentStatus && !contentStatus.found && (
        <div className="cos-empty">
          Content root not found at{" "}
          <code className="cos-source-path">{contentStatus.root}</code>.
        </div>
      )}

      {/* Attention + Signals mount points are intentionally hidden until
       * a feature PRD registers cards. PRD-115 §6.1 + §7.6 — empty
       * placeholder copy is an anti-pattern. */}
    </div>
  );
}

function PriorityCard({
  index,
  item,
  onOpen,
}: {
  index: number;
  item: PriorityItem;
  onOpen: () => void;
}) {
  const clickable = Boolean(item.rel_path || item.task_id);
  const Tag = clickable ? "button" : "div";
  return (
    <Tag
      type={clickable ? "button" : undefined}
      className={`cos-priority-card source-${item.source}`}
      onClick={clickable ? onOpen : undefined}
    >
      <span className="cos-priority-card-index" aria-hidden>
        {index}
      </span>
      <span className="cos-priority-card-dot" aria-hidden />
      <span className="cos-priority-card-text">
        <InlineMarkdown text={item.text} />
      </span>
      {item.rel_path ? (
        <FileText
          size={14}
          strokeWidth={1.75}
          className="cos-priority-card-link"
          aria-hidden
        />
      ) : null}
    </Tag>
  );
}

/** Local-timezone YYYY-MM-DD. The skill writes briefings under
 * `date +%Y-%m-%d` (local), so comparing with the UTC ISO would
 * misclassify "today" as "yesterday" past local 7 PM in CT. */
function localDateString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function greetingForToday(): string {
  const d = new Date();
  return `${DAY_NAMES[d.getDay()]}, ${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`;
}

function briefingRelative(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const target = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  target.setHours(0, 0, 0, 0);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const days = Math.round((now.getTime() - target.getTime()) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days > 1 && days < 14) return `${days}d`;
  return date;
}

// =============================================================
// B9-CP29 — Home strip dispatcher. Reads user-configured order
// from homePrefs and renders strips in that sequence. Each strip
// is responsible for its own "hidden when empty" rule; the
// dispatcher just orders them.
// =============================================================
import {
  HOME_PREFS_CHANGED,
  readHomePrefs,
  type HomeStripId,
} from "../state/homePrefs";

function HomeStrips() {
  const [order, setOrder] = useState<HomeStripId[]>(
    () => readHomePrefs().stripOrder,
  );
  useEffect(() => {
    const onChange = () => setOrder(readHomePrefs().stripOrder);
    window.addEventListener(HOME_PREFS_CHANGED, onChange);
    return () => window.removeEventListener(HOME_PREFS_CHANGED, onChange);
  }, []);
  return (
    <>
      {order.map((id) => {
        if (id === "needs-review") return <NeedsReviewStrip key={id} />;
        if (id === "incidents") return <ActiveIncidentsStrip key={id} />;
        if (id === "oncall") return <OncallStrip key={id} />;
        return null;
      })}
    </>
  );
}

function formatAgendaTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function HomeAgendaRow({
  event,
  onOpenDoc,
  onGoToMeeting,
  onGoToProfile,
}: {
  event: CalendarEvent;
  onOpenDoc: (doc: OpenDoc) => void;
  onGoToMeeting: (target: MeetingTarget) => void;
  onGoToProfile: (target: ProfileTarget) => void;
}) {
  const [prep, setPrep] = useState<PrepTarget | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const found = await findPrepTarget(event);
      if (!cancelled) setPrep(found);
    })();
    return () => {
      cancelled = true;
    };
  }, [event.uid, event.summary, event.start]);

  const time = event.all_day ? "all day" : formatAgendaTime(event.start);
  const onClick = () => {
    if (!prep) return;
    openPrepTarget(prep, { onOpenDoc, onGoToMeeting, onGoToProfile });
  };
  const title = prep
    ? prep.kind === "meeting-session" || prep.kind === "person-session"
      ? "Open today's session"
      : prep.kind === "meeting-readme"
        ? `${prep.meeting.label} — start a session`
        : `${prep.person.label} — open profile`
    : event.summary;

  if (prep) {
    return (
      <li className="cos-home-agenda-row is-clickable">
        <button
          type="button"
          className="cos-home-agenda-button"
          onClick={onClick}
          title={title}
        >
          <span className="cos-home-agenda-time">{time}</span>
          <span className="cos-home-agenda-title">{event.summary}</span>
        </button>
      </li>
    );
  }
  return (
    <li className="cos-home-agenda-row">
      <span className="cos-home-agenda-time">{time}</span>
      <span className="cos-home-agenda-title" title={event.summary}>
        {event.summary}
      </span>
    </li>
  );
}

// =============================================================
// B8-CP29 — Needs-review strip on Home. Top 3 review-blocking
// PRs. Hidden when zero (PRD-115 §5 "lead with one thing").
// =============================================================

type HomePr = {
  number: number;
  title: string;
  url: string;
  repo: string;
};

function NeedsReviewStrip() {
  const [prs, setPrs] = useState<HomePr[]>([]);
  useEffect(() => {
    let cancelled = false;
    invoke<HomePr[]>("gh_review_requests", { limit: 3 })
      .then((rows) => {
        if (!cancelled) setPrs(rows.slice(0, 3));
      })
      .catch(() => {
        /* gh missing / unauth → render nothing */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (prs.length === 0) return null;
  return (
    <section
      className="cos-home-needs-review"
      aria-label="Pull requests waiting on you"
    >
      <SectionHeader
        label={`${prs.length} PR${prs.length === 1 ? "" : "s"} waiting on you`}
      />
      <ul className="cos-home-pr-list">
        {prs.map((pr) => (
          <li key={pr.url}>
            <button
              type="button"
              className="cos-home-pr-row"
              onClick={() => openUrl(pr.url).catch(() => {})}
              title={pr.url}
            >
              <span className="cos-home-pr-repo">{pr.repo}</span>
              <span className="cos-home-pr-num">#{pr.number}</span>
              <span className="cos-home-pr-title">{pr.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// =============================================================
// B8-CP30 — Active-incidents strip on Home. Reads the snapshot
// the /ops-incidents skill writes; never invokes — Home is for
// scanning, not refreshing.
// =============================================================

type HomeIncident = {
  id?: string;
  title: string;
  severity?: string;
  url?: string;
};

// =============================================================
// B9-CP7 — On-call strip on Home. Hidden when no PagerDuty token
// or no pinned service id. PD service id resolves to who is
// primary/secondary right now via paging_for_service.
// =============================================================

type HomeOncall = {
  policy_name: string;
  level: number;
  user_name: string;
  user_url: string;
};

function OncallStrip() {
  const [rows, setRows] = useState<HomeOncall[]>([]);
  const [serviceLabel, setServiceLabel] = useState<string>("");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const prefsRaw = localStorage.getItem("cos:ops-prefs");
        const prefs = prefsRaw ? JSON.parse(prefsRaw) : null;
        const serviceId = prefs?.homeServiceId as string | undefined;
        if (!serviceId) return;
        setServiceLabel(prefs?.homeServiceLabel || serviceId);
        const v = await invoke<HomeOncall[]>("paging_for_service", {
          serviceId,
        });
        if (!cancelled) setRows(v.sort((a, b) => a.level - b.level).slice(0, 3));
      } catch {
        // silent — strip stays hidden
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  if (rows.length === 0) return null;
  return (
    <section
      className="cos-home-incidents"
      aria-label={`On-call for ${serviceLabel}`}
    >
      <SectionHeader label={`On-call · ${serviceLabel}`} />
      <ul className="cos-home-incidents-list">
        {rows.map((r) => (
          <li key={`${r.policy_name}-${r.level}`}>
            <button
              type="button"
              className="cos-home-incident-row"
              onClick={() => openUrl(r.user_url).catch(() => {})}
            >
              <span className="cos-home-incident-sev">L{r.level}</span>
              <span className="cos-home-incident-title">{r.user_name}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ActiveIncidentsStrip() {
  const [incidents, setIncidents] = useState<HomeIncident[]>([]);
  useEffect(() => {
    let cancelled = false;
    invoke<{ incidents: HomeIncident[] }>("ops_incidents_read")
      .then((v) => {
        if (cancelled) return;
        // Filter to active SEV-1 + SEV-2 only — Home is for "needs
        // attention right now", not historical state. /ops-incidents
        // (the Slack-driven source) marks resolved threads with
        // `state: resolved`; skip those.
        const active = (v.incidents ?? []).filter((i) => {
          const s = (i.severity ?? "").toUpperCase();
          if (s !== "SEV-1" && s !== "SEV-2") return false;
          const state = ((i as { state?: string }).state ?? "").toLowerCase();
          return state !== "resolved";
        });
        setIncidents(active.slice(0, 3));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (incidents.length === 0) return null;
  return (
    <section
      className="cos-home-incidents"
      aria-label="Active incidents (SEV-1 + SEV-2)"
    >
      <SectionHeader
        label={`${incidents.length} active SEV-1/2 incident${incidents.length === 1 ? "" : "s"}`}
      />
      <ul className="cos-home-incidents-list">
        {incidents.map((i, ix) => (
          <li key={i.id ?? `${i.title}-${ix}`}>
            <button
              type="button"
              className="cos-home-incident-row"
              onClick={() => {
                if (i.url) openUrl(i.url).catch(() => {});
              }}
              disabled={!i.url}
            >
              <span className="cos-home-incident-sev">
                {i.severity ?? "?"}
              </span>
              <span className="cos-home-incident-title">{i.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

