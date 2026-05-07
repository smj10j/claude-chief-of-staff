/**
 * Velocity / PR attention score (PRD-109 §5.1, B8-CP8).
 *
 * The whole point of this scoring is that the user can *trust* the
 * order. Every factor is named, every weight is defaulted to a
 * value the user can override in Settings → Velocity (B8-CP12),
 * and every PR shows its breakdown on click (B8-CP9). No black
 * box, no opaque "ML score".
 *
 * Inputs are kept narrow: a `PrRow` (the same shape we render) plus
 * an optional reviewer count. CI status, blocker labels, etc. are
 * folded in later CPs as the data becomes available.
 */

export type PrLike = {
  is_draft: boolean;
  created_at: string;
  updated_at: string;
  labels: string[];
  /** Reviewers who could currently approve. We don't have the field
   *  from `gh search prs` — defaults to 1. CP11 wires this in via
   *  `gh pr view`. */
  reviewer_count?: number;
  /** B8-CP11 fold-in. `null` until CP11 lands the per-row checks. */
  ci_status?: "green" | "yellow" | "red" | null;
};

/** Tunable weights. The defaults match PRD-109 §5.1's example
 *  formula exactly so the docs are runnable. */
export type ScoreWeights = {
  age: { day1: number; days1to3: number; days3to7: number; over7: number };
  ci: { green: number; yellow: number; red: number };
  label: { default_: number; blocker: number; critical: number };
  staleness: { fresh: number; warm: number; stale: number };
};

export const DEFAULT_WEIGHTS: ScoreWeights = {
  age: { day1: 0.5, days1to3: 1.0, days3to7: 1.5, over7: 2.0 },
  ci: { green: 1.0, yellow: 1.25, red: 1.75 },
  label: { default_: 1.0, blocker: 1.5, critical: 2.0 },
  staleness: { fresh: 1.0, warm: 1.25, stale: 1.5 },
};

export type ScoreFactors = {
  age: number;
  ci: number;
  label: number;
  staleness: number;
  reviewers: number;
};

export type ScoreResult = {
  score: number;
  factors: ScoreFactors;
};

/**
 * Compute attention score per PRD-109 §5.1:
 *
 *   attention = age_factor × ci_factor × label_factor × staleness_factor
 *               ÷ max(1, reviewer_count)
 *
 * Higher = more attention needed.
 */
export function attentionScore(
  pr: PrLike,
  weights: ScoreWeights = DEFAULT_WEIGHTS,
  now: number = Date.now(),
): ScoreResult {
  const age = ageFactor(pr.created_at, weights, now);
  const ci = ciFactor(pr.ci_status ?? null, weights);
  const label = labelFactor(pr.labels, weights);
  const staleness = stalenessFactor(pr.updated_at, weights, now);
  const reviewers = Math.max(1, pr.reviewer_count ?? 1);
  const score = (age * ci * label * staleness) / reviewers;
  return { score, factors: { age, ci, label, staleness, reviewers } };
}

export function ageFactor(
  createdAt: string,
  weights: ScoreWeights,
  now: number,
): number {
  const days = daysSince(createdAt, now);
  if (days < 1) return weights.age.day1;
  if (days < 3) return weights.age.days1to3;
  if (days < 7) return weights.age.days3to7;
  return weights.age.over7;
}

export function ciFactor(
  status: "green" | "yellow" | "red" | null,
  weights: ScoreWeights,
): number {
  // Until CP11 lands the per-row CI fetch, treat unknown as green —
  // the score should not penalise a PR for data we haven't gathered.
  if (status === null) return weights.ci.green;
  return weights.ci[status];
}

export function labelFactor(labels: string[], weights: ScoreWeights): number {
  // PRD-109 §5.1: "max wins" across critical / blocker / default.
  const lower = labels.map((l) => l.toLowerCase());
  if (lower.some((l) => l.includes("critical") || l === "p0")) {
    return weights.label.critical;
  }
  if (
    lower.some(
      (l) => l === "blocker" || l === "blocked" || l.includes("urgent"),
    )
  ) {
    return weights.label.blocker;
  }
  return weights.label.default_;
}

export function stalenessFactor(
  updatedAt: string,
  weights: ScoreWeights,
  now: number,
): number {
  const hours = hoursSince(updatedAt, now);
  if (hours < 24) return weights.staleness.fresh;
  if (hours < 48) return weights.staleness.warm;
  return weights.staleness.stale;
}

/**
 * "Stale" surfaces in the UI as a chip on its own (B8-CP10). PR is
 * stale when its last activity is older than 48 h.
 */
export function isStale(updatedAt: string, now: number = Date.now()): boolean {
  return hoursSince(updatedAt, now) >= 48;
}

function daysSince(iso: string, now: number): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return (now - t) / (1000 * 60 * 60 * 24);
}

function hoursSince(iso: string, now: number): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return (now - t) / (1000 * 60 * 60);
}

/**
 * Sort PRs by attention desc — highest score first. Stable on score
 * ties (uses updated_at desc as tiebreak).
 */
export function sortByAttention(
  rows: PrLike[],
  weights: ScoreWeights = DEFAULT_WEIGHTS,
  now: number = Date.now(),
): PrLike[] {
  const scored = rows.map((row) => ({ row, ...attentionScore(row, weights, now) }));
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (
      (Date.parse(b.row.updated_at) || 0) - (Date.parse(a.row.updated_at) || 0)
    );
  });
  return scored.map((x) => x.row);
}
