import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bucketTasks, isOverdue, type V1Task } from "./Work";

function task(id: string, due: string | null, priority: V1Task["priority"] = "medium"): V1Task {
  return {
    id,
    title: `Task ${id}`,
    status: "todo",
    priority,
    due,
    project: null,
    notes: null,
    tags: [],
    links: [],
    created_at: null,
    updated_at: null,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 3, 25, 12, 0, 0)); // 2026-04-25
});
afterEach(() => {
  vi.useRealTimers();
});

describe("isOverdue (B5/B6 task surface)", () => {
  it("returns false when no due date", () => {
    expect(isOverdue(task("a", null))).toBe(false);
  });

  it("returns false for today's date (due today is not overdue)", () => {
    expect(isOverdue(task("a", "2026-04-25"))).toBe(false);
  });

  it("returns true for past dates", () => {
    expect(isOverdue(task("a", "2026-04-24"))).toBe(true);
    expect(isOverdue(task("a", "2026-04-01"))).toBe(true);
  });

  it("ignores time portion when present", () => {
    expect(isOverdue(task("a", "2026-04-25 23:59"))).toBe(false);
    expect(isOverdue(task("a", "2026-04-24 23:59"))).toBe(true);
  });
});

describe("bucketTasks (B6-CP6 / CP11 — feeds filter chips + j/k nav)", () => {
  it("places overdue + today in Now", () => {
    const tasks = [task("yesterday", "2026-04-24"), task("today", "2026-04-25")];
    const b = bucketTasks(tasks);
    expect(b.now.map((t) => t.id).sort()).toEqual(["today", "yesterday"]);
    expect(b.thisWeek).toEqual([]);
  });

  it("places due-in-1-7d in This week", () => {
    const b = bucketTasks([task("plus3", "2026-04-28")]);
    expect(b.thisWeek.map((t) => t.id)).toEqual(["plus3"]);
    expect(b.now).toEqual([]);
  });

  it("places due-in-8-14d in Soon", () => {
    const b = bucketTasks([task("plus10", "2026-05-05")]);
    expect(b.soon.map((t) => t.id)).toEqual(["plus10"]);
  });

  it("places no-date and far-future in Someday", () => {
    const b = bucketTasks([
      task("nodate", null),
      task("faraway", "2027-01-01"),
    ]);
    expect(b.someday.map((t) => t.id).sort()).toEqual(["faraway", "nodate"]);
  });

  it("preserves relative order within a bucket (input order in)", () => {
    const a = task("a", "2026-04-26");
    const b = task("b", "2026-04-27");
    const c = task("c", "2026-04-28");
    const bucketed = bucketTasks([c, a, b]);
    expect(bucketed.thisWeek.map((t) => t.id)).toEqual(["c", "a", "b"]);
  });

  it("returns empty buckets for an empty input", () => {
    const b = bucketTasks([]);
    expect(b.now).toEqual([]);
    expect(b.thisWeek).toEqual([]);
    expect(b.soon).toEqual([]);
    expect(b.someday).toEqual([]);
  });
});
