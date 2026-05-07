import { invoke } from "@tauri-apps/api/core";

import { type CalendarEvent } from "../surfaces/Calendar";
import { type MeetingTarget } from "../surfaces/MeetingDetail";
import { type MeetingRef, type SessionMeta } from "../surfaces/Meetings";
import { type PersonRef } from "../surfaces/People";
import { type ProfileTarget } from "../surfaces/PersonProfile";
import { type OpenDoc } from "./openDoc";

/**
 * Where a calendar event's "open prep" should land. Same-day session
 * file when one exists; otherwise the meeting / person detail view so
 * the user can spin one up.
 */
export type PrepTarget =
  | { kind: "meeting-session"; meeting: MeetingTarget; session: SessionMeta }
  | { kind: "meeting-readme"; meeting: MeetingTarget }
  | { kind: "person-session"; person: ProfileTarget; session: SessionMeta }
  | { kind: "person-profile"; person: ProfileTarget };

export async function findPrepTarget(
  event: CalendarEvent,
): Promise<PrepTarget | null> {
  const day = localDay(new Date(event.start));
  const titleSlug = slugify(event.summary);
  const tokens = nameTokens(event.summary);

  try {
    const meetings = await invoke<MeetingRef[]>("content_list_meetings");
    const meetingHit = await matchMeeting(meetings, titleSlug, day);
    if (meetingHit) return meetingHit;

    const people = await invoke<PersonRef[]>("content_list_people");
    const personHit = await matchPerson(people, tokens, day);
    if (personHit) return personHit;
  } catch {
    // Backend down or list failed — silently skip; the row still renders.
  }
  return null;
}

export type PrepNav = {
  onOpenDoc: (doc: OpenDoc) => void;
  onGoToMeeting: (target: MeetingTarget) => void;
  onGoToProfile: (target: ProfileTarget) => void;
};

export function openPrepTarget(prep: PrepTarget, nav: PrepNav): void {
  switch (prep.kind) {
    case "meeting-session":
      nav.onOpenDoc({
        relPath: prep.session.rel_path,
        label: prep.session.date,
        crumbs: [{ label: prep.meeting.label, meeting: prep.meeting }],
      });
      return;
    case "meeting-readme":
      nav.onGoToMeeting(prep.meeting);
      return;
    case "person-session":
      nav.onOpenDoc({
        relPath: prep.session.rel_path,
        label: prep.session.date,
        crumbs: [{ label: prep.person.label, profile: prep.person }],
      });
      return;
    case "person-profile":
      nav.onGoToProfile(prep.person);
      return;
  }
}

async function matchMeeting(
  meetings: MeetingRef[],
  titleSlug: string,
  day: string,
): Promise<PrepTarget | null> {
  let m = meetings.find(
    (mm) => slugify(mm.label) === titleSlug || mm.slug === titleSlug,
  );
  if (!m) {
    // Calendar event titles often add or drop modifiers (e.g. event
    // "Payments Eng Leadership Sync" vs meeting folder "payments-eng-leadership").
    // Fall back to bidirectional slug containment with a 2-segment minimum
    // on the meeting side to avoid matching on a single noisy word like
    // "weekly" or "review".
    const candidates = meetings
      .map((mm) => ({ meeting: mm, slug: mm.slug || slugify(mm.label) }))
      .filter(
        (c) => c.slug.length > 0 && c.slug.split("-").length >= 2,
      );
    const containing = candidates.filter(
      (c) =>
        slugContains(titleSlug, c.slug) || slugContains(c.slug, titleSlug),
    );
    if (containing.length > 0) {
      // Prefer the longest matching slug — most specific wins when several
      // meetings share a prefix (e.g. "team-eng-leads" vs "team-eng").
      containing.sort((a, b) => b.slug.length - a.slug.length);
      m = containing[0].meeting;
    }
  }
  if (!m) return null;
  const target: MeetingTarget = {
    slug: m.slug,
    label: m.label,
    rel_path: m.rel_path,
  };
  const sessions = await invoke<SessionMeta[]>("content_list_sessions", {
    relPath: m.rel_path,
    limit: 0,
  });
  const hit = sessions.find((s) => s.date === day);
  if (hit) return { kind: "meeting-session", meeting: target, session: hit };
  return { kind: "meeting-readme", meeting: target };
}

async function matchPerson(
  people: PersonRef[],
  tokens: string[],
  day: string,
): Promise<PrepTarget | null> {
  if (tokens.length === 0) return null;
  let hit = people.find((p) => tokens.includes(p.slug));
  if (!hit) {
    hit = people.find((p) =>
      tokens.includes(slugify(p.label.split(/\s+/)[0] ?? "")),
    );
  }
  if (!hit) return null;
  const target: ProfileTarget = {
    slug: hit.slug,
    label: hit.label,
    rel_path: hit.rel_path,
  };
  const sessions = await invoke<SessionMeta[]>("content_list_sessions", {
    relPath: hit.rel_path,
    limit: 0,
  });
  const sameDay = sessions.find((s) => s.date === day);
  if (sameDay) {
    return { kind: "person-session", person: target, session: sameDay };
  }
  return { kind: "person-profile", person: target };
}

/** Substring containment that respects slug-segment boundaries: only
 *  matches when `needle` lines up with whole hyphen-delimited segments
 *  inside `haystack`. Prevents "lend" from matching "lending". */
function slugContains(haystack: string, needle: string): boolean {
  if (!haystack || !needle) return false;
  if (haystack === needle) return true;
  return (
    haystack.startsWith(`${needle}-`) ||
    haystack.endsWith(`-${needle}`) ||
    haystack.includes(`-${needle}-`)
  );
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function nameTokens(title: string): string[] {
  const noise = new Set([
    "1-1",
    "1on1",
    "11",
    "with",
    "and",
    "skip",
    "level",
    "skip-level",
    "weekly",
    "biweekly",
    "user",
    "example-user",
  ]);
  return title
    .split(/[\s/<>+&:|,]+/)
    .map((t) => slugify(t))
    .filter((t) => t.length > 0 && !noise.has(t));
}

function localDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
