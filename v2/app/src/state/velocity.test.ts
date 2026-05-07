import { describe, it, expect } from "vitest";

import {
  attentionScore,
  DEFAULT_WEIGHTS,
  isStale,
  sortByAttention,
  type PrLike,
} from "./velocity";

const NOW = Date.parse("2026-04-25T12:00:00Z");

function pr(over: Partial<PrLike>): PrLike {
  return {
    is_draft: false,
    created_at: "2026-04-24T12:00:00Z",
    updated_at: "2026-04-25T11:00:00Z",
    labels: [],
    ...over,
  };
}

describe("attentionScore", () => {
  it("returns the docs example for a fresh, green, unlabelled, single-reviewer PR", () => {
    const r = attentionScore(pr({}), DEFAULT_WEIGHTS, NOW);
    // age (1d): 1.0; ci unknown→green: 1.0; label default: 1.0; fresh: 1.0; reviewers: 1
    expect(r.factors.age).toBeCloseTo(1.0);
    expect(r.factors.ci).toBeCloseTo(1.0);
    expect(r.factors.label).toBeCloseTo(1.0);
    expect(r.factors.staleness).toBeCloseTo(1.0);
    expect(r.factors.reviewers).toBe(1);
    expect(r.score).toBeCloseTo(1.0);
  });

  it("escalates a stale, red, blocker PR with 4-day age", () => {
    const r = attentionScore(
      pr({
        created_at: "2026-04-21T12:00:00Z", // 4 days
        updated_at: "2026-04-23T08:00:00Z", // 52h
        labels: ["blocker"],
        ci_status: "red",
      }),
      DEFAULT_WEIGHTS,
      NOW,
    );
    // age 1.5 × ci 1.75 × label 1.5 × staleness 1.5 ÷ 1
    expect(r.score).toBeCloseTo(1.5 * 1.75 * 1.5 * 1.5);
  });

  it("divides by reviewer count when more than 1", () => {
    const single = attentionScore(pr({}), DEFAULT_WEIGHTS, NOW).score;
    const triple = attentionScore(
      pr({ reviewer_count: 3 }),
      DEFAULT_WEIGHTS,
      NOW,
    ).score;
    expect(triple).toBeCloseTo(single / 3);
  });

  it("treats unknown CI as green so we don't penalise missing data", () => {
    const r = attentionScore(pr({ ci_status: null }), DEFAULT_WEIGHTS, NOW);
    expect(r.factors.ci).toBeCloseTo(DEFAULT_WEIGHTS.ci.green);
  });

  it("max-wins for label tier — critical beats blocker beats default", () => {
    const blocker = attentionScore(pr({ labels: ["blocker"] }), DEFAULT_WEIGHTS, NOW)
      .factors.label;
    const critical = attentionScore(
      pr({ labels: ["blocker", "critical"] }),
      DEFAULT_WEIGHTS,
      NOW,
    ).factors.label;
    expect(critical).toBeGreaterThan(blocker);
  });
});

describe("isStale", () => {
  it("flags PRs untouched for 48h+", () => {
    expect(isStale("2026-04-23T11:00:00Z", NOW)).toBe(true);
    expect(isStale("2026-04-24T13:00:00Z", NOW)).toBe(false);
  });
});

describe("sortByAttention", () => {
  it("puts higher-score PRs first", () => {
    const rows = [
      pr({ labels: [], updated_at: "2026-04-25T11:00:00Z" }),
      pr({ labels: ["critical"], updated_at: "2026-04-25T11:00:00Z" }),
      pr({ labels: ["blocker"], updated_at: "2026-04-25T11:00:00Z" }),
    ];
    const sorted = sortByAttention(rows, DEFAULT_WEIGHTS, NOW);
    expect(sorted[0].labels).toContain("critical");
    expect(sorted[2].labels.length).toBe(0);
  });

  it("ties break by most-recently-updated desc", () => {
    const a = pr({ updated_at: "2026-04-25T10:00:00Z" });
    const b = pr({ updated_at: "2026-04-25T11:00:00Z" });
    const c = pr({ updated_at: "2026-04-25T09:00:00Z" });
    const sorted = sortByAttention([a, b, c], DEFAULT_WEIGHTS, NOW);
    expect(sorted.map((r) => r.updated_at)).toEqual([
      "2026-04-25T11:00:00Z",
      "2026-04-25T10:00:00Z",
      "2026-04-25T09:00:00Z",
    ]);
  });
});
