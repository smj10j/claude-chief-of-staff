/**
 * User-tunable preferences for the Velocity surface (B8-CP12).
 *
 * Lives in localStorage so it persists across reloads but stays out
 * of the app DB — these are workstation-level preferences, not data
 * the user would ever recover from a backup. Two surfaces both
 * read this: Settings → GitHub edits it; Work → PRs / Review reads
 * it before sorting + rendering.
 */

const KEY = "cos:velocity-prefs";

export type VelocityPrefs = {
  /**
   * Authors whose PRs should be hidden from PR / Review tabs by
   * default. Bot users are noisy; keeping them out of the queue
   * means attention scoring isn't fighting against a wall of
   * dependabot bumps. Stored as bare logins (case-insensitive
   * compare).
   */
  excludedAuthors: string[];
  /** When true, the tabs render bot PRs alongside humans. Useful
   *  for "did our renovate run break?" checks. */
  showBots: boolean;
};

export const DEFAULT_PREFS: VelocityPrefs = {
  excludedAuthors: [
    "dependabot[bot]",
    "renovate[bot]",
    "github-actions[bot]",
    "snyk-bot",
  ],
  showBots: false,
};

export function readPrefs(): VelocityPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<VelocityPrefs>;
    return {
      excludedAuthors:
        Array.isArray(parsed.excludedAuthors) && parsed.excludedAuthors.length > 0
          ? parsed.excludedAuthors.filter((s) => typeof s === "string")
          : DEFAULT_PREFS.excludedAuthors,
      showBots: Boolean(parsed.showBots ?? DEFAULT_PREFS.showBots),
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function writePrefs(next: VelocityPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent(VELOCITY_PREFS_CHANGED));
  } catch {
    /* localStorage may be denied by a managed profile */
  }
}

/** Event name for cross-surface live updates after a write. */
export const VELOCITY_PREFS_CHANGED = "cos:velocity-prefs-changed";

/**
 * Filter a PR list against the user's prefs. Pure for testability.
 */
export function filterByPrefs<T extends { author: string; author_is_bot: boolean }>(
  rows: T[],
  prefs: VelocityPrefs,
): T[] {
  if (prefs.showBots) return rows;
  const excluded = new Set(
    prefs.excludedAuthors.map((s) => s.toLowerCase()),
  );
  return rows.filter((r) => {
    if (r.author_is_bot) return false;
    if (excluded.has(r.author.toLowerCase())) return false;
    return true;
  });
}
