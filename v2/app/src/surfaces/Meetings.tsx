import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { newSessionForOwner } from "../state/newSession";
import { type OpenDoc } from "../state/openDoc";
import { SurfaceHero } from "../ui";
import { MeetingDetail, type MeetingTarget } from "./MeetingDetail";

export type MeetingRef = {
  slug: string;
  label: string;
  rel_path: string;
  has_readme: boolean;
  session_count: number;
  last_session: string | null;
};

export type SessionMeta = {
  date: string;
  rel_path: string;
};

type Load =
  | { kind: "loading" }
  | { kind: "ok"; meetings: MeetingRef[] }
  | { kind: "error"; error: string };

type Props = {
  onOpenDoc: (doc: OpenDoc) => void;
  /** When set, render MeetingDetail in place of the list — same pattern
   *  as People → PersonProfile and Projects → ProjectDetail. */
  profile: MeetingTarget | null;
  onGoToMeeting: (target: MeetingTarget) => void;
  onClearMeeting: () => void;
};

/**
 * Recurring Meetings surface — per-folder browser under
 * `areas/meetings/` with README + session jump. Calendar lives in its
 * own top-level surface (PRD-111 split). When `profile` is set, this
 * surface renders MeetingDetail instead of the list.
 */
export function Meetings({
  onOpenDoc,
  profile,
  onGoToMeeting,
  onClearMeeting,
}: Props) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  // pinnedRel is the meeting the user pinned via the "sessions" button —
  // survives mouse leave. Hover state lives per-card.
  const [pinnedRel, setPinnedRel] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const meetings = await invoke<MeetingRef[]>("content_list_meetings");
        if (!cancelled) setLoad({ kind: "ok", meetings });
      } catch (error) {
        if (!cancelled) setLoad({ kind: "error", error: String(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Detail view short-circuits the list, mirroring People → PersonProfile
  // and Projects → ProjectDetail. MUST come after all hook calls so the
  // hook order stays stable across the detail ↔ list transition.
  if (profile) {
    return (
      <MeetingDetail
        target={profile}
        onOpenDoc={onOpenDoc}
        onBack={onClearMeeting}
      />
    );
  }

  if (load.kind === "loading") {
    return <div className="cos-empty">Loading meetings…</div>;
  }
  if (load.kind === "error") {
    return (
      <div className="cos-empty cos-empty-error">
        Failed to load meetings: {load.error}
      </div>
    );
  }
  if (load.meetings.length === 0) {
    return (
      <div className="cos-empty">
        <p>No meetings yet.</p>
        <p className="cos-empty-hint">
          Create a folder under <code>data/files/areas/meetings/</code> with a{" "}
          <code>README.md</code> + <code>sessions/</code> directory.
        </p>
      </div>
    );
  }

  return (
    <div className="cos-meetings">
      <SurfaceHero
        title="Recurring Meetings"
        subtitle={`${load.meetings.length} forum${
          load.meetings.length === 1 ? "" : "s"
        } under areas/meetings/, sorted by most recent session.`}
      />
      <ul className="cos-meetings-list" role="list">
        {load.meetings.map((m) => (
          <MeetingCard
            key={m.rel_path}
            meeting={m}
            pinned={pinnedRel === m.rel_path}
            onTogglePin={() =>
              setPinnedRel((cur) => (cur === m.rel_path ? null : m.rel_path))
            }
            onGoToMeeting={onGoToMeeting}
            onOpenDoc={onOpenDoc}
          />
        ))}
      </ul>
    </div>
  );
}

function MeetingCard({
  meeting,
  pinned,
  onTogglePin,
  onGoToMeeting,
  onOpenDoc,
}: {
  meeting: MeetingRef;
  pinned: boolean;
  onTogglePin: () => void;
  onGoToMeeting: (target: MeetingTarget) => void;
  onOpenDoc: (doc: OpenDoc) => void;
}) {
  const stale = useMemo(
    () =>
      meeting.last_session ? staleLabel(meeting.last_session) : null,
    [meeting.last_session],
  );
  const sessionsLabel =
    meeting.session_count === 0
      ? "no sessions"
      : meeting.session_count === 1
        ? "1 session"
        : `${meeting.session_count} sessions`;

  // Hover state with a small open delay so glancing past doesn't open
  // every card. Close is immediate. Pinning via the "sessions" button
  // keeps the list open regardless of hover (touch / keyboard / a11y).
  const [hovered, setHovered] = useState(false);
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

  const hasSessions = meeting.session_count > 0;
  const showSessions = hasSessions && (pinned || hovered);

  const target: MeetingTarget = {
    slug: meeting.slug,
    label: meeting.label,
    rel_path: meeting.rel_path,
  };

  const openMeeting = () => onGoToMeeting(target);

  // Click anywhere on the card body → open the meeting detail. Inner
  // controls (sessions list, "+ new", "sessions" pin button) all
  // stopPropagation so they only do their own thing.
  const onCardClick = () => {
    openMeeting();
  };
  const onCardKeyDown = (e: React.KeyboardEvent<HTMLLIElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openMeeting();
    }
  };

  const newSession = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const result = await newSessionForOwner(meeting.rel_path, meeting.label);
    if (result.error || !result.relPath) {
      window.alert(result.error ?? "could not create session");
      return;
    }
    const date = result.relPath.split("/").pop()?.replace(/\.md$/, "") ?? "";
    onOpenDoc({
      relPath: result.relPath,
      label: date,
      crumbs: [{ label: meeting.label, meeting: target }],
    });
  };

  return (
    <li
      className={`cos-meeting-card is-clickable${showSessions ? " is-open" : ""}${
        pinned ? " is-pinned" : ""
      }`}
      role="button"
      tabIndex={0}
      onClick={onCardClick}
      onKeyDown={onCardKeyDown}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      aria-label={`Open ${meeting.label}`}
    >
      <div className="cos-meeting-row">
        <div className="cos-meeting-main">
          <span className="cos-meeting-label">{meeting.label}</span>
          {!meeting.has_readme && (
            <span className="cos-chip cos-chip-muted">no README</span>
          )}
        </div>
        <div className="cos-meeting-meta">
          <span className="cos-meeting-sessions">{sessionsLabel}</span>
          {stale && (
            <span
              className={`cos-meeting-staleness ${
                stale.tone === "stale" ? "cos-meeting-staleness-stale" : ""
              }`}
              title={meeting.last_session ?? ""}
            >
              {stale.label}
            </span>
          )}
          <button
            type="button"
            className="cos-btn cos-btn-ghost cos-meeting-toggle"
            onClick={newSession}
            title="Create today's session file"
          >
            + new
          </button>
          <button
            type="button"
            className="cos-btn cos-btn-ghost cos-meeting-toggle"
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin();
            }}
            disabled={!hasSessions}
            aria-expanded={showSessions}
            title={
              !hasSessions
                ? "No sessions yet"
                : pinned
                  ? "Unpin session list"
                  : "Pin session list open (otherwise auto-collapses on mouse leave)"
            }
          >
            {pinned ? "hide sessions" : "sessions"}
          </button>
        </div>
      </div>
      {showSessions && (
        <SessionsBlock
          relPath={meeting.rel_path}
          label={meeting.label}
          onOpenDoc={onOpenDoc}
          meetingTarget={target}
        />
      )}
    </li>
  );
}

function SessionsBlock({
  relPath,
  label,
  onOpenDoc,
  meetingTarget,
}: {
  relPath: string;
  label: string;
  onOpenDoc: (doc: OpenDoc) => void;
  meetingTarget: MeetingTarget;
}) {
  const [load, setLoad] = useState<
    | { kind: "loading" }
    | { kind: "ok"; sessions: SessionMeta[] }
    | { kind: "error"; error: string }
  >({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sessions = await invoke<SessionMeta[]>("content_list_sessions", {
          relPath,
          limit: 12,
        });
        if (!cancelled) setLoad({ kind: "ok", sessions });
      } catch (error) {
        if (!cancelled) setLoad({ kind: "error", error: String(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [relPath]);

  // Inner block lives inside a clickable card — swallow clicks so an
  // accidental tap on whitespace inside doesn't open the detail view.
  const stop = (e: React.MouseEvent | React.KeyboardEvent) =>
    e.stopPropagation();

  if (load.kind === "loading") {
    return (
      <div className="cos-meeting-sessions-block" onClick={stop}>
        Loading…
      </div>
    );
  }
  if (load.kind === "error") {
    return (
      <div
        className="cos-meeting-sessions-block cos-empty-error"
        onClick={stop}
      >
        {load.error}
      </div>
    );
  }
  if (load.sessions.length === 0) {
    return (
      <div
        className="cos-meeting-sessions-block cos-empty-hint"
        onClick={stop}
      >
        No sessions yet.
      </div>
    );
  }
  return (
    <ul className="cos-meeting-sessions-block" role="list" onClick={stop}>
      {load.sessions.map((s) => (
        <li key={s.rel_path}>
          <button
            type="button"
            className="cos-meeting-session-row"
            onClick={(e) => {
              e.stopPropagation();
              onOpenDoc({
                relPath: s.rel_path,
                label: s.date,
                crumbs: [{ label, meeting: meetingTarget }],
              });
            }}
          >
            <span className="cos-meeting-session-date">{s.date}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function staleLabel(
  date: string,
): { label: string; tone: "fresh" | "stale" } {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return { label: date, tone: "fresh" };
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const target = new Date(d);
  target.setHours(0, 0, 0, 0);
  const days = Math.round((now.getTime() - target.getTime()) / 86_400_000);
  if (days <= 0) return { label: "today", tone: "fresh" };
  if (days === 1) return { label: "yesterday", tone: "fresh" };
  if (days < 14) return { label: `${days}d ago`, tone: "fresh" };
  if (days < 60) return { label: `${Math.round(days / 7)}w ago`, tone: "stale" };
  return { label: `${Math.round(days / 30)}mo ago`, tone: "stale" };
}
