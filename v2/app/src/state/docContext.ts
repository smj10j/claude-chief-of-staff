/**
 * Infer the navigation context (surface, parent profile, breadcrumbs)
 * for a document's relPath. Used by `handleOpenDoc` when the caller
 * (Recent list, command palette, CLI handoff, intra-doc cmd-click)
 * doesn't supply explicit crumbs — without this, opening a 1:1
 * session from Recent would land on Home with breadcrumbs reading
 * "Home > 2026-05-06" instead of "People > Alice > 2026-05-06".
 *
 * Returns null when the path doesn't sit under a known hierarchy.
 * The caller falls back to the doc-only opening flow.
 */

import { type OpenDoc } from "./openDoc";
import { type SurfaceId } from "./surfaces";
import { type MeetingTarget } from "../surfaces/MeetingDetail";
import { type ProfileTarget } from "../surfaces/PersonProfile";
import { type ProjectTarget } from "../surfaces/ProjectDetail";

export type DocContext = {
  surface: SurfaceId;
  peopleProfile: ProfileTarget | null;
  projectProfile: ProjectTarget | null;
  meetingProfile: MeetingTarget | null;
  crumbs: NonNullable<OpenDoc["crumbs"]>;
};

/**
 * Walk the rel-path and identify the parent entity. Paths are
 * content-root relative (`areas/...`, `projects/...`) — the
 * `data/files/` prefix is stripped by the backend before paths reach
 * the UI, so the matcher accepts both forms defensively.
 *
 * Patterns recognized:
 *   areas/one-on-ones/<rel-type>/<slug>/...   → People
 *   areas/meetings/<slug>/...                 → Meetings
 *   projects/<slug>/...                       → Projects
 *
 * Anything else (career notes, inbox, ad-hoc area docs) returns null
 * — those legitimately have no parent entity to crumb up to.
 */
export function inferDocContext(relPath: string): DocContext | null {
  const raw = relPath.split("/").filter(Boolean);
  // Tolerate both `areas/...` (current) and `data/files/areas/...`
  // (legacy / defensive) — strip the prefix if present.
  const parts =
    raw[0] === "data" && raw[1] === "files" ? raw.slice(2) : raw;

  // People — both profile README and dated session files.
  if (parts[0] === "areas" && parts[1] === "one-on-ones") {
    const relType = parts[2];
    const slug = parts[3];
    if (!relType || !slug) return null;
    const rel_path = `areas/one-on-ones/${relType}/${slug}`;
    const label = humanize(slug);
    const profile: ProfileTarget = { slug, label, rel_path };
    return {
      surface: "people",
      peopleProfile: profile,
      projectProfile: null,
      meetingProfile: null,
      crumbs: [{ label, profile }],
    };
  }

  if (parts[0] === "areas" && parts[1] === "meetings") {
    const slug = parts[2];
    if (!slug) return null;
    const rel_path = `areas/meetings/${slug}`;
    const label = humanize(slug);
    const meeting: MeetingTarget = { slug, label, rel_path };
    return {
      surface: "meetings",
      peopleProfile: null,
      projectProfile: null,
      meetingProfile: meeting,
      crumbs: [{ label, meeting }],
    };
  }

  if (parts[0] === "projects") {
    const slug = parts[1];
    if (!slug) return null;
    const rel_path = `projects/${slug}`;
    const label = humanize(slug);
    const project: ProjectTarget = { slug, label, rel_path };
    return {
      surface: "projects",
      peopleProfile: null,
      projectProfile: project,
      meetingProfile: null,
      crumbs: [{ label, project }],
    };
  }

  return null;
}

/**
 * Humanize a kebab-case slug into a display label. Best-effort: a
 * brand name like "payments" lands as "Payments" rather than "Payments" — the
 * crumb is still navigable, and the destination surface re-reads the
 * canonical label from disk if the user clicks through.
 */
function humanize(slug: string): string {
  return slug
    .split("-")
    .map((w) => (w.length === 0 ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(" ");
}
