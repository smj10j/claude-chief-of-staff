/**
 * Persistent MRU list of recently-opened docs. Stored in localStorage
 * so it survives app restarts; capped to RECENT_MAX so the strip
 * doesn't grow unbounded.
 *
 * Pure functions + a thin window wrapper — no React. Components
 * subscribe via the recordRecent / readRecent helpers and bust their
 * own state on the cos:recent-changed event.
 */

const STORAGE_KEY = "cos.recent-docs.v1";
const PINNED_KEY = "cos.pinned-recent.v1";
const SIDEBAR_MAX_KEY = "cos.sidebar-recents-max.v1";
export const RECENT_MAX = 15;
export const RECENT_CHANGED_EVENT = "cos:recent-changed";

/** The three sidebar-recents-max options exposed in Settings. The
 *  underlying RECENT_MAX is sized to the largest option so we never
 *  trim a doc the sidebar might want to render. */
export const SIDEBAR_RECENTS_MAX_OPTIONS = [5, 10, 15] as const;
export type SidebarRecentsMax = (typeof SIDEBAR_RECENTS_MAX_OPTIONS)[number];
export const DEFAULT_SIDEBAR_RECENTS_MAX: SidebarRecentsMax = 5;

export function readSidebarRecentsMax(): SidebarRecentsMax {
  if (typeof window === "undefined") return DEFAULT_SIDEBAR_RECENTS_MAX;
  try {
    const raw = window.localStorage.getItem(SIDEBAR_MAX_KEY);
    const n = raw ? Number.parseInt(raw, 10) : NaN;
    if ((SIDEBAR_RECENTS_MAX_OPTIONS as readonly number[]).includes(n)) {
      return n as SidebarRecentsMax;
    }
  } catch {
    // ignore
  }
  return DEFAULT_SIDEBAR_RECENTS_MAX;
}

export function writeSidebarRecentsMax(value: SidebarRecentsMax): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SIDEBAR_MAX_KEY, String(value));
    // The sidebar listens to recents-changed and re-reads the cap on
    // each event — reuse that bus so flipping the dropdown updates
    // the rendered list immediately.
    window.dispatchEvent(new CustomEvent(RECENT_CHANGED_EVENT));
  } catch {
    // ignore
  }
}

export type RecentDoc = {
  relPath: string;
  label: string;
  /** Unix milliseconds when the user most recently opened this doc. */
  openedAt: number;
  /** True if the user pinned this doc (B7-CP25). Pinned docs survive
   *  the RECENT_MAX trim and float to the top of the sidebar list. */
  pinned?: boolean;
};

/**
 * Console transcripts are machine-written session logs, not docs the
 * user curates — every opened session used to auto-record here and
 * flooded the recent-files list. They restore through their own tab
 * persistence (`cos.console.tabs.v1`), so they have no business in the
 * doc MRU. This is the single chokepoint: `recordRecent` refuses them
 * and `normalize` drops any that a prior build already persisted, so
 * existing litter self-heals on the next read/write.
 */
export function isRecentEligible(relPath: string): boolean {
  return !relPath.split("/").filter(Boolean).includes("console-sessions");
}

export function readRecent(): RecentDoc[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const docs = normalize(parsed);
    const pinnedSet = readPinnedSet();
    return docs.map((d) =>
      pinnedSet.has(d.relPath) ? { ...d, pinned: true } : d,
    );
  } catch {
    return [];
  }
}

function readPinnedSet(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(PINNED_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

/**
 * Pin or unpin a recent doc. Pinned docs survive RECENT_MAX trim
 * AND float to the top of the list when readRecent is called.
 * Idempotent: pinning a doc that's already pinned is a no-op.
 */
export function togglePinned(relPath: string): boolean {
  if (typeof window === "undefined") return false;
  const set = readPinnedSet();
  let pinned: boolean;
  if (set.has(relPath)) {
    set.delete(relPath);
    pinned = false;
  } else {
    set.add(relPath);
    pinned = true;
  }
  try {
    window.localStorage.setItem(PINNED_KEY, JSON.stringify([...set]));
    window.dispatchEvent(new CustomEvent(RECENT_CHANGED_EVENT));
  } catch {
    // ignore — quota / private mode
  }
  return pinned;
}

export function isPinned(relPath: string): boolean {
  return readPinnedSet().has(relPath);
}

/**
 * Push the given doc to the front of the recent list. Dedupes by
 * relPath (latest open wins); trims unpinned entries down to
 * RECENT_MAX. Pinned entries always survive the trim. Fires a
 * window event so subscribers re-read without prop drilling.
 */
export function recordRecent(relPath: string, label: string): void {
  if (typeof window === "undefined") return;
  if (!relPath) return;
  // Never let console transcripts into the doc MRU (see isRecentEligible).
  if (!isRecentEligible(relPath)) return;
  const now = Date.now();
  const existing = readRecent().filter((d) => d.relPath !== relPath);
  const head: RecentDoc = { relPath, label, openedAt: now };
  const candidates = [head, ...existing];
  // Keep all pinned entries; trim unpinned to RECENT_MAX.
  const pinned = candidates.filter((d) => d.pinned);
  const unpinnedTrimmed = candidates
    .filter((d) => !d.pinned)
    .slice(0, RECENT_MAX);
  const next = mergePreservingOrder(candidates, [
    ...pinned,
    ...unpinnedTrimmed,
  ]);
  // Strip the runtime-only `pinned` field before persistence — the
  // pinned set is a separate localStorage key, source of truth.
  const stripped = next.map(({ pinned: _, ...rest }) => rest);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stripped));
    window.dispatchEvent(new CustomEvent(RECENT_CHANGED_EVENT));
  } catch {
    // Quota / private mode — best effort.
  }
}

/** Restore `keep`'s membership using `all`'s order so we don't
 *  accidentally re-sort during trim. */
function mergePreservingOrder(
  all: RecentDoc[],
  keep: RecentDoc[],
): RecentDoc[] {
  const keepSet = new Set(keep.map((d) => d.relPath));
  return all.filter((d) => keepSet.has(d.relPath));
}

/**
 * Render a label that's actually distinguishable when many recent
 * docs share a generic name. "README" alone or "2026-04-25" alone is
 * useless in a list — prefix the parent folder/project/person so the
 * user can tell items apart.
 *
 * Pure function so the sidebar, Home strip, and command palette can
 * all decorate consistently. Returns the original label when it's
 * already specific (the case for ad-hoc Areas docs, etc).
 */
const GENERIC_LABEL_RE = /^(?:readme|index)$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function decorateRecentLabel(
  relPath: string,
  label: string,
): string {
  const trimmed = (label ?? "").trim();
  const looksGeneric =
    trimmed.length === 0 ||
    GENERIC_LABEL_RE.test(trimmed) ||
    ISO_DATE_RE.test(trimmed);
  if (!looksGeneric) return trimmed;
  // Walk up from the rel-path until we find a parent segment that's
  // not "sessions" / "areas" / etc — that's the human-meaningful
  // owner (person slug, project slug, meeting slug). humanize "-"
  // separators so "team-eng-leads" reads as "Team Eng Leads".
  const parts = relPath.split("/").filter(Boolean);
  // Drop the filename itself.
  parts.pop();
  const skip = new Set([
    "sessions",
    "archive",
    "areas",
    "data",
    "files",
    "projects",
    "meetings",
    "one-on-ones",
    "direct-reports",
    "manager",
    "peers",
    "skip-level",
    "skip-level-reports",
    "xfn",
  ]);
  let owner: string | null = null;
  for (let i = parts.length - 1; i >= 0; i--) {
    const seg = parts[i];
    if (!seg || skip.has(seg)) continue;
    owner = seg;
    break;
  }
  if (!owner) return trimmed.length > 0 ? trimmed : "doc";
  const humanized = owner
    .split("-")
    .map((w) => (w.length === 0 ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(" ");
  return trimmed.length > 0 ? `${humanized} · ${trimmed}` : humanized;
}

/** Title-case a hyphen-slug: "team-eng-leads" → "Team Eng Leads". */
function humanizeSlug(slug: string): string {
  return slug
    .split("-")
    .map((w) => (w.length === 0 ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(" ");
}

// Relationship folders that sit between `one-on-ones/` and the person
// slug, e.g. one-on-ones/direct-reports/alice/…
const RECENT_OWNER_RELATIONSHIPS = new Set([
  "direct-reports",
  "manager",
  "peers",
  "skip-level",
  "skip-level-reports",
  "xfn",
  "self",
  "alumni",
]);
// A trailing standalone year on a project slug ("offsite-2026") — the
// project's own docs keep their year, but the owner prefix reads cleaner
// without it ("Offsite/…").
const TRAILING_YEAR_RE = /-(?:19|20)\d{2}$/;

/**
 * The human-meaningful "owner" of a recent doc, derived from its
 * rel-path:
 *   - one-on-ones/<relationship>/<person>/…  → the person slug
 *   - projects/<project>/…                   → the project slug
 *   - areas/meetings/<meeting>/…             → the meeting slug
 * Returns null for ad-hoc docs (loose Areas files, etc) with no owner.
 */
function recentOwnerSlug(relPath: string): string | null {
  const parts = relPath.split("/").filter(Boolean);

  const projIdx = parts.indexOf("projects");
  if (projIdx !== -1 && parts[projIdx + 1]) return parts[projIdx + 1]!;

  const oooIdx = parts.indexOf("one-on-ones");
  if (oooIdx !== -1) {
    const relationship = parts[oooIdx + 1];
    const person = parts[oooIdx + 2];
    if (
      relationship &&
      RECENT_OWNER_RELATIONSHIPS.has(relationship) &&
      person
    ) {
      return person;
    }
  }

  const meetIdx = parts.indexOf("meetings");
  if (meetIdx !== -1 && parts[meetIdx + 1]) return parts[meetIdx + 1]!;

  return null;
}

/**
 * Display label for the Recent lists (Home strip, Sidebar, command
 * palette). Always surfaces the owner as "Owner/Doc" so items read as
 * "Alice/Mid Year Checkin 2026" or
 * "Offsite/example-spec" and are scannable at a glance.
 *
 * Unlike `decorateRecentLabel` (used for tab titles, which only prefixes
 * generic labels to stay short), this prefixes the owner whenever one can
 * be derived — the doc's own label (title, date, or filename stem) is left
 * as-is after the slash. Falls back to the bare label for docs with no
 * owner (loose Areas files).
 */
export function recentDisplayLabel(relPath: string, label: string): string {
  const trimmed = (label ?? "").trim();
  const owner = recentOwnerSlug(relPath);
  if (!owner) return trimmed.length > 0 ? trimmed : "doc";
  const stripped = owner.replace(TRAILING_YEAR_RE, "");
  const ownerLabel = humanizeSlug(stripped.length > 0 ? stripped : owner);
  return trimmed.length > 0 ? `${ownerLabel}/${trimmed}` : ownerLabel;
}

export function clearRecent(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
    window.dispatchEvent(new CustomEvent(RECENT_CHANGED_EVENT));
  } catch {
    // ignore
  }
}

function normalize(value: unknown): RecentDoc[] {
  if (!Array.isArray(value)) return [];
  const out: RecentDoc[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.relPath !== "string" || rec.relPath.length === 0) continue;
    if (typeof rec.label !== "string") continue;
    // Purge console transcripts a prior build may have persisted — they
    // drop out of the rendered list here and get physically removed on
    // the next recordRecent write (which reads through this filter).
    if (!isRecentEligible(rec.relPath)) continue;
    const openedAt =
      typeof rec.openedAt === "number" && Number.isFinite(rec.openedAt)
        ? rec.openedAt
        : 0;
    out.push({
      relPath: rec.relPath,
      label: rec.label,
      openedAt,
    });
  }
  // No slice here on purpose — recordRecent does the cap-aware trim
  // that respects pinned entries (B7-CP25). If we sliced again here,
  // pinned docs that fell past RECENT_MAX-of-everything would
  // disappear on the next read despite being kept on disk.
  return out;
}
