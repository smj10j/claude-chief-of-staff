import { useMemo } from "react";

export type TimelineEventTone = "own" | "maybe" | "declined" | "needs-prep";

export type TimelineEvent = {
  id: string;
  /** ISO date-time string for the event start. */
  start: string;
  /** ISO date-time string for the event end (optional; assumes 1h if missing). */
  end?: string | null;
  /** Display label shown in the block. */
  label: string;
  /** Tone for visual treatment. Defaults to "own". */
  tone?: TimelineEventTone;
  /** Optional click handler — typically opens prep doc. */
  onClick?: () => void;
};

export type TimelineStripProps = {
  events: TimelineEvent[];
  /**
   * Optional explicit time range (ISO strings). If omitted, derived from
   * the first/last event ±1 hour, clamped to a default 8am–8pm window.
   */
  range?: { from: string; to: string };
  /** Empty-state copy shown when `events` is empty. */
  emptyLabel?: string;
};

/**
 * Horizontal time-blocked event strip — proportional ribbons across a day.
 * Used by Home (today's calendar at-a-glance) and Meetings calendar week-grid.
 * PRD-115 §6.1, §6.5; principle 4 (Meetings is temporal).
 */
export function TimelineStrip({
  events,
  range,
  emptyLabel = "No events on this day.",
}: TimelineStripProps) {
  const sorted = useMemo(
    () => [...events].sort((a, b) => a.start.localeCompare(b.start)),
    [events],
  );

  const { fromMs, toMs } = useMemo(() => {
    if (range) {
      return { fromMs: Date.parse(range.from), toMs: Date.parse(range.to) };
    }
    if (sorted.length === 0) {
      const today = new Date();
      const f = new Date(today);
      f.setHours(8, 0, 0, 0);
      const t = new Date(today);
      t.setHours(20, 0, 0, 0);
      return { fromMs: f.getTime(), toMs: t.getTime() };
    }
    const first = Date.parse(sorted[0].start);
    const lastEnd = Date.parse(
      sorted[sorted.length - 1].end ?? sorted[sorted.length - 1].start,
    );
    const dayStart = new Date(first);
    dayStart.setHours(8, 0, 0, 0);
    const dayEnd = new Date(first);
    dayEnd.setHours(20, 0, 0, 0);
    return {
      fromMs: Math.min(first - 30 * 60_000, dayStart.getTime()),
      toMs: Math.max(lastEnd + 30 * 60_000, dayEnd.getTime()),
    };
  }, [range, sorted]);

  const span = Math.max(toMs - fromMs, 1);

  if (sorted.length === 0) {
    return (
      <div className="cos-timeline-strip cos-timeline-strip-empty">
        {emptyLabel}
      </div>
    );
  }

  return (
    <div
      className="cos-timeline-strip"
      role="list"
      aria-label="Today's calendar"
    >
      {sorted.map((event) => {
        const startMs = Date.parse(event.start);
        const endMs = event.end ? Date.parse(event.end) : startMs + 60 * 60_000;
        const left = ((startMs - fromMs) / span) * 100;
        const width = Math.max(((endMs - startMs) / span) * 100, 4);
        const tone = event.tone ?? "own";
        const time = new Date(startMs).toLocaleTimeString(undefined, {
          hour: "numeric",
          minute: "2-digit",
        });
        const Tag = event.onClick ? "button" : "div";
        return (
          <Tag
            key={event.id}
            role="listitem"
            type={event.onClick ? "button" : undefined}
            className={`cos-timeline-event tone-${tone}`}
            style={{ left: `${left}%`, width: `${width}%` }}
            onClick={event.onClick}
          >
            <span className="cos-timeline-event-time">{time}</span>
            <span className="cos-timeline-event-label">{event.label}</span>
          </Tag>
        );
      })}
    </div>
  );
}
