import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

import {
  extractConferenceLink,
  plainDescription,
} from "../state/conferenceLink";
import { type OpenDoc } from "../state/openDoc";
import {
  findPrepTarget,
  openPrepTarget,
  type PrepTarget,
} from "../state/calendarPrep";
import { SurfaceHero } from "../ui";
import { type MeetingTarget } from "./MeetingDetail";
import { type ProfileTarget } from "./PersonProfile";

export type CalendarEvent = {
  uid: string;
  summary: string;
  start: string;
  end: string;
  all_day: boolean;
  location: string | null;
  description: string | null;
  organizer: string | null;
  attendees: string[];
  status: string | null;
};

export type CalendarConfig = {
  ics_url: string;
  transport: "ics" | "eventkit";
};

type CalLoad =
  | { kind: "loading" }
  | { kind: "ok"; events: CalendarEvent[] }
  | { kind: "error"; error: string }
  | { kind: "needs-config" };

type Props = {
  onOpenDoc: (doc: OpenDoc) => void;
  onGoToMeeting: (target: MeetingTarget) => void;
  onGoToProfile: (target: ProfileTarget) => void;
};

/**
 * Calendar surface (PRD-111). Today + 6 more days from an ICS subscription
 * or EventKit. Rendered as its own top-level surface so the breadcrumb
 * chain doesn't have to thread through a "Meetings" parent.
 */
type ViewMode = "list" | "grid";

const VIEW_STORAGE_KEY = "cos.calendar-view.v1";

function readView(): ViewMode {
  if (typeof window === "undefined") return "list";
  try {
    const v = window.localStorage.getItem(VIEW_STORAGE_KEY);
    return v === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
}

export function Calendar({ onOpenDoc, onGoToMeeting, onGoToProfile }: Props) {
  const [load, setLoad] = useState<CalLoad>({ kind: "loading" });
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [view, setView] = useState<ViewMode>(() => readView());

  const changeView = (next: ViewMode) => {
    setView(next);
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      // ignore — quota / private mode
    }
  };

  const openCalendarSettings = () => {
    window.dispatchEvent(
      new CustomEvent("cos:goto", {
        detail: { surface: "settings", section: "calendar" },
      }),
    );
  };

  // Week offset (0 = current week, +1 = next, -1 = previous). Driven
  // by the grid view's keyboard nav + step buttons. List view ignores
  // it (always today-onwards, since the list is the "what's coming
  // up" view).
  const [weekOffset, setWeekOffset] = useState(0);

  const range = useMemo(
    () => gridRangeFor(new Date(), weekOffset),
    [weekOffset],
  );

  // Reset to the current week whenever the user re-mounts the
  // surface (going away and back) — week offset is intentionally
  // ephemeral so leaving + returning doesn't strand the user a
  // few weeks out.
  useEffect(() => {
    setWeekOffset(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await invoke<CalendarConfig>("calendar_config_get");
        if (cancelled) return;
        const cfgTransport = cfg.transport === "eventkit" ? "eventkit" : "ics";
        if (
          cfgTransport === "ics" &&
          (!cfg.ics_url || cfg.ics_url.trim() === "")
        ) {
          setLoad({ kind: "needs-config" });
          return;
        }
        setLoad({ kind: "loading" });
        const events = await invoke<CalendarEvent[]>("calendar_events", {
          from: range.fromIso,
          to: range.toIso,
        });
        if (!cancelled) setLoad({ kind: "ok", events });
      } catch (error) {
        if (!cancelled) setLoad({ kind: "error", error: String(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [range.fromIso, range.toIso, refreshNonce]);

  const eventCount = load.kind === "ok" ? load.events.length : 0;
  const heroSubtitle =
    load.kind === "loading"
      ? "Fetching events…"
      : load.kind === "needs-config"
        ? "Calendar source not configured."
        : load.kind === "error"
          ? "Calendar unavailable — see error below."
          : eventCount === 0
            ? "No events in the next 7 days."
            : `${eventCount} event${eventCount === 1 ? "" : "s"} across the next 7 days.`;

  return (
    <div className="cos-calendar">
      <SurfaceHero
        title="Calendar"
        subtitle={heroSubtitle}
        actions={
          <>
            <div className="cos-calendar-view-toggle" role="tablist" aria-label="Calendar view">
              <button
                type="button"
                role="tab"
                aria-selected={view === "list"}
                className={`cos-btn cos-btn-ghost${view === "list" ? " is-active" : ""}`}
                onClick={() => changeView("list")}
              >
                list
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={view === "grid"}
                className={`cos-btn cos-btn-ghost${view === "grid" ? " is-active" : ""}`}
                onClick={() => changeView("grid")}
              >
                week grid
              </button>
            </div>
            <button
              type="button"
              className="cos-btn cos-btn-ghost"
              onClick={openCalendarSettings}
            >
              settings
            </button>
            <button
              type="button"
              className="cos-btn"
              onClick={() => setRefreshNonce((n) => n + 1)}
              disabled={load.kind === "loading"}
            >
              {load.kind === "loading" ? "refreshing…" : "refresh"}
            </button>
          </>
        }
      />

      {load.kind === "needs-config" && (
        <div className="cos-empty">
          <p>Calendar source not configured.</p>
          <button
            type="button"
            className="cos-btn"
            onClick={openCalendarSettings}
          >
            configure in Settings
          </button>
        </div>
      )}
      {load.kind === "loading" && <div className="cos-empty">Fetching events…</div>}
      {load.kind === "error" && (
        <div className="cos-empty cos-empty-error">{load.error}</div>
      )}
      {load.kind === "ok" && view === "list" && (
        <EventsList
          events={load.events}
          fromIso={range.fromIso}
          toIso={range.toIso}
          onOpenDoc={onOpenDoc}
          onGoToMeeting={onGoToMeeting}
          onGoToProfile={onGoToProfile}
        />
      )}
      {load.kind === "ok" && view === "grid" && (
        <WeekGrid
          events={load.events}
          fromIso={range.fromIso}
          weekOffset={weekOffset}
          onPrev={() => setWeekOffset((n) => n - 1)}
          onNext={() => setWeekOffset((n) => n + 1)}
          onReset={() => setWeekOffset(0)}
          onOpenDoc={onOpenDoc}
          onGoToMeeting={onGoToMeeting}
          onGoToProfile={onGoToProfile}
        />
      )}
    </div>
  );
}

function EventsList({
  events,
  fromIso,
  toIso,
  onOpenDoc,
  onGoToMeeting,
  onGoToProfile,
}: {
  events: CalendarEvent[];
  fromIso: string;
  toIso: string;
  onOpenDoc: (doc: OpenDoc) => void;
  onGoToMeeting: (target: MeetingTarget) => void;
  onGoToProfile: (target: ProfileTarget) => void;
}) {
  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const e of events) {
      const d = localDay(new Date(e.start));
      const list = map.get(d) ?? [];
      list.push(e);
      map.set(d, list);
    }
    return Array.from(map.entries()).sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
  }, [events]);

  const todayIso = localDay(new Date());
  const todayRef = useRef<HTMLElement | null>(null);

  // Scroll today's section into view on mount when it exists in the
  // current range — mirrors the grid view's CP12 behavior. List view
  // is fixed at "today + 6 days" so today is always present, but
  // the ref + check pattern keeps this honest for future uses where
  // the range might shift.
  useEffect(() => {
    const el = todayRef.current;
    if (!el) return;
    el.scrollIntoView({ behavior: "auto", block: "start" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (events.length === 0) {
    return (
      <div className="cos-empty">
        <p>No events between {fromIso} and {toIso}.</p>
      </div>
    );
  }

  return (
    <div className="cos-calendar-days">
      {byDay.map(([day, dayEvents]) => (
        <section
          key={day}
          ref={day === todayIso ? todayRef : undefined}
          className="cos-calendar-day"
        >
          <h2 className="cos-calendar-day-head">{dayHeading(day)}</h2>
          <ul className="cos-calendar-events" role="list">
            {dayEvents.map((e) => (
              <CalendarEventRow
                key={e.uid + e.start}
                event={e}
                onOpenDoc={onOpenDoc}
                onGoToMeeting={onGoToMeeting}
                onGoToProfile={onGoToProfile}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function WeekGrid({
  events,
  fromIso,
  weekOffset,
  onPrev,
  onNext,
  onReset,
  onOpenDoc,
  onGoToMeeting,
  onGoToProfile,
}: {
  events: CalendarEvent[];
  fromIso: string;
  weekOffset: number;
  onPrev: () => void;
  onNext: () => void;
  onReset: () => void;
  onOpenDoc: (doc: OpenDoc) => void;
  onGoToMeeting: (target: MeetingTarget) => void;
  onGoToProfile: (target: ProfileTarget) => void;
}) {
  const todayRef = useRef<HTMLElement | null>(null);
  // Scroll today's column into view on first render. Useful when the
  // user deep-links into Calendar mid-week and the row would otherwise
  // start at Sunday off-screen.
  useEffect(() => {
    const el = todayRef.current;
    if (!el) return;
    el.scrollIntoView({ behavior: "auto", block: "nearest", inline: "center" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Arrow-key navigation: ← prev week, → next week, Home → reset to
  // today. Skipped when an input is focused so the date-format chip
  // strip etc don't fight us.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        t?.isContentEditable
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        onPrev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        onNext();
      } else if (e.key === "Home") {
        e.preventDefault();
        onReset();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onPrev, onNext, onReset]);
  const days = useMemo(() => {
    // Always render exactly 7 columns starting from `fromIso`, even if a
    // day has no events — the grid shape is the value here.
    const start = parseLocalDay(fromIso);
    const out: { iso: string; events: CalendarEvent[] }[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      const iso = localDay(d);
      const dayEvents = events
        .filter(
          (e) => e.status !== "cancelled" && localDay(new Date(e.start)) === iso,
        )
        .sort((a, b) => a.start.localeCompare(b.start));
      out.push({ iso, events: dayEvents });
    }
    return out;
  }, [events, fromIso]);
  const todayIso = localDay(new Date());

  const weekLabel = weekOffset === 0
    ? "This week"
    : weekOffset === 1
      ? "Next week"
      : weekOffset === -1
        ? "Last week"
        : weekOffset > 0
          ? `${weekOffset} weeks ahead`
          : `${-weekOffset} weeks back`;

  return (
    <>
      <div
        className="cos-calendar-grid-nav"
        role="toolbar"
        aria-label="Week navigation"
      >
        <button
          type="button"
          className="cos-btn cos-btn-ghost"
          onClick={onPrev}
          title="Previous week (←)"
          aria-label="Previous week"
        >
          ← prev
        </button>
        <span className="cos-calendar-grid-nav-label">{weekLabel}</span>
        <button
          type="button"
          className="cos-btn cos-btn-ghost"
          onClick={onNext}
          title="Next week (→)"
          aria-label="Next week"
        >
          next →
        </button>
        {weekOffset !== 0 && (
          <button
            type="button"
            className="cos-btn cos-btn-ghost"
            onClick={onReset}
            title="Back to this week (Home)"
          >
            today
          </button>
        )}
      </div>
    <div className="cos-calendar-grid" role="list" aria-label="Calendar week">
      {days.map(({ iso, events: dayEvents }) => (
        <section
          key={iso}
          ref={iso === todayIso ? todayRef : undefined}
          className={`cos-calendar-grid-col${iso === todayIso ? " is-today" : ""}`}
          role="listitem"
        >
          <h3 className="cos-calendar-grid-head">{gridDayHeading(iso)}</h3>
          {dayEvents.length === 0 ? (
            <p className="cos-calendar-grid-empty">—</p>
          ) : (
            <ul className="cos-calendar-grid-events">
              {dayEvents.map((e) => (
                <CalendarGridCell
                  key={e.uid + e.start}
                  event={e}
                  onOpenDoc={onOpenDoc}
                  onGoToMeeting={onGoToMeeting}
                  onGoToProfile={onGoToProfile}
                />
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
    </>
  );
}

function CalendarGridCell({
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
  const time = event.all_day
    ? "all day"
    : formatTime(event.start);
  const onClick = () => {
    if (!prep) return;
    openPrepTarget(prep, { onOpenDoc, onGoToMeeting, onGoToProfile });
  };
  const Tag = prep ? "button" : "div";
  return (
    <li className="cos-calendar-grid-cell-wrap">
      <Tag
        type={prep ? "button" : undefined}
        className={`cos-calendar-grid-cell${prep ? " is-clickable" : ""}`}
        onClick={prep ? onClick : undefined}
        title={prep ? "Open prep" : event.summary}
      >
        <span className="cos-calendar-grid-cell-time">{time}</span>
        <span className="cos-calendar-grid-cell-title">{event.summary}</span>
      </Tag>
    </li>
  );
}

function gridDayHeading(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  const weekday = d.toLocaleDateString(undefined, { weekday: "short" });
  const month = d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return `${weekday} · ${month}`;
}

function parseLocalDay(iso: string): Date {
  // Build a Date pinned to local noon so DST shifts don't roll the day.
  return new Date(`${iso}T12:00:00`);
}

function CalendarEventRow({
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
  const [expanded, setExpanded] = useState(false);

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

  const openPrep = () => {
    if (!prep) return;
    openPrepTarget(prep, { onOpenDoc, onGoToMeeting, onGoToProfile });
  };

  const prepLabel = prep
    ? prep.kind === "meeting-session" || prep.kind === "person-session"
      ? "open session"
      : prep.kind === "meeting-readme"
        ? "open meeting"
        : "open profile"
    : null;
  const prepTitle = prep
    ? prep.kind === "meeting-session"
      ? prep.session.rel_path
      : prep.kind === "meeting-readme"
        ? `${prep.meeting.label} — start a session`
        : prep.kind === "person-session"
          ? prep.session.rel_path
          : `${prep.person.label} — open profile`
    : "";

  const time = event.all_day
    ? "all day"
    : `${formatTime(event.start)} – ${formatTime(event.end)}`;
  const isCancelled = event.status === "cancelled";
  const conf = useMemo(
    () => extractConferenceLink(event.description),
    [event.description],
  );
  const description = useMemo(
    () => plainDescription(event.description),
    [event.description],
  );
  const hasDetails =
    description.length > 0 || event.attendees.length > 0 || conf !== null;

  return (
    <li
      className={`cos-calendar-event ${isCancelled ? "is-cancelled" : ""} ${
        expanded ? "is-expanded" : ""
      }`}
    >
      <button
        type="button"
        className="cos-calendar-event-main"
        onClick={() => hasDetails && setExpanded((v) => !v)}
        aria-expanded={hasDetails ? expanded : undefined}
        disabled={!hasDetails}
        title={hasDetails ? "Show event details" : event.summary}
      >
        <div className="cos-calendar-event-time">{time}</div>
        <div className="cos-calendar-event-body">
          <div className="cos-calendar-event-title">{event.summary}</div>
          {event.location && (
            <div className="cos-calendar-event-meta">{event.location}</div>
          )}
        </div>
      </button>
      <div className="cos-calendar-event-actions">
        {conf && (
          <button
            type="button"
            className="cos-btn cos-btn-ghost"
            title={conf.url}
            onClick={(e) => {
              e.stopPropagation();
              openUrl(conf.url).catch(() => {
                navigator.clipboard?.writeText(conf.url).catch(() => {});
              });
            }}
          >
            join {conf.kind}
          </button>
        )}
        {prep && prepLabel ? (
          <button
            type="button"
            className="cos-btn cos-btn-ghost"
            title={prepTitle}
            onClick={(e) => {
              e.stopPropagation();
              openPrep();
            }}
          >
            {prepLabel}
          </button>
        ) : null}
      </div>
      {expanded && (
        <div className="cos-calendar-event-detail">
          {description && (
            <pre className="cos-calendar-event-description">
              {description}
            </pre>
          )}
          {event.attendees.length > 0 && (
            <div className="cos-calendar-event-attendees">
              <span className="cos-calendar-event-attendees-label">
                Attendees ({event.attendees.length}):
              </span>{" "}
              {event.attendees.join(", ")}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function dayHeading(iso: string): string {
  const todayIso = localDay(new Date());
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowIso = localDay(tomorrow);
  if (iso === todayIso) return `Today · ${iso}`;
  if (iso === tomorrowIso) return `Tomorrow · ${iso}`;
  const d = new Date(`${iso}T12:00:00`);
  const weekday = d.toLocaleDateString(undefined, { weekday: "long" });
  return `${weekday} · ${iso}`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function localDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Compute the [fromIso, toIso] range for the calendar grid view at a
 * given week offset relative to the local "now". Pure so unit tests
 * can pin the offset math without rendering.
 *
 *   weekOffset =  0 → today + 6 days (the default).
 *   weekOffset = +1 → 7 days ahead, then 6 more.
 *   weekOffset = -1 → 7 days back, then 6 more.
 */
export function gridRangeFor(now: Date, weekOffset: number): {
  fromIso: string;
  toIso: string;
} {
  const start = new Date(now);
  start.setDate(start.getDate() + weekOffset * 7);
  const fromIso = localDay(start);
  const to = new Date(start);
  to.setDate(to.getDate() + 6);
  const toIso = localDay(to);
  return { fromIso, toIso };
}
