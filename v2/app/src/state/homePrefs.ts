/**
 * Home prefs (B9-CP29). User-customizable order of the data strips
 * Home renders below the calendar / priorities. Default order
 * mirrors the historical render order; users can reorder via the
 * Settings → Home section.
 */

const KEY = "cos:home-prefs";

export type HomeStripId = "needs-review" | "incidents" | "oncall";

export type HomePrefs = {
  /** Order of strip ids. Strips not present in this list render
   *  in their default position at the end. */
  stripOrder: HomeStripId[];
};

export const ALL_STRIPS: HomeStripId[] = [
  "needs-review",
  "incidents",
  "oncall",
];

export const DEFAULT_HOME_PREFS: HomePrefs = {
  stripOrder: [...ALL_STRIPS],
};

export function readHomePrefs(): HomePrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_HOME_PREFS;
    const parsed = JSON.parse(raw) as Partial<HomePrefs>;
    const order = (parsed.stripOrder ?? []).filter((s): s is HomeStripId =>
      (ALL_STRIPS as string[]).includes(s),
    );
    // Append any missing strips at the end so adding a new strip
    // type later doesn't make it invisible for users who already
    // wrote a partial order.
    for (const s of ALL_STRIPS) {
      if (!order.includes(s)) order.push(s);
    }
    return { stripOrder: order };
  } catch {
    return DEFAULT_HOME_PREFS;
  }
}

export function writeHomePrefs(next: HomePrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent(HOME_PREFS_CHANGED));
  } catch {
    // ignore
  }
}

export const HOME_PREFS_CHANGED = "cos:home-prefs-changed";

/** Move stripId one step in the given direction. Returns the new order. */
export function moveStrip(
  order: HomeStripId[],
  stripId: HomeStripId,
  delta: -1 | 1,
): HomeStripId[] {
  const ix = order.indexOf(stripId);
  if (ix < 0) return order;
  const target = ix + delta;
  if (target < 0 || target >= order.length) return order;
  const next = [...order];
  [next[ix], next[target]] = [next[target], next[ix]];
  return next;
}

export const STRIP_LABELS: Record<HomeStripId, string> = {
  "needs-review": "PRs waiting on you",
  incidents: "Active incidents (SEV-1/2)",
  oncall: "On-call right now",
};
