import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { relativeDue } from "./Work";

// All cases pin to "today = 2026-04-25" so "in 3d" / "2d ago" assertions
// don't drift with calendar time.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 3, 25, 12, 0, 0)); // April is month index 3
});
afterEach(() => {
  vi.useRealTimers();
});

describe("relativeDue", () => {
  it("'today' for the current local day", () => {
    expect(relativeDue("2026-04-25").label).toBe("today");
    expect(relativeDue("2026-04-25").tone).toBe("soon");
  });

  it("'tomorrow' / 'yesterday' next-day shortcuts", () => {
    expect(relativeDue("2026-04-26").label).toBe("tomorrow");
    expect(relativeDue("2026-04-26").tone).toBe("soon");
    expect(relativeDue("2026-04-24").label).toBe("yesterday");
    expect(relativeDue("2026-04-24").tone).toBe("overdue");
  });

  it("'in Nd' for short future windows; 'soon' tone within 3 days", () => {
    expect(relativeDue("2026-04-27").label).toBe("in 2d");
    expect(relativeDue("2026-04-27").tone).toBe("soon");
    expect(relativeDue("2026-04-29").label).toBe("in 4d");
    expect(relativeDue("2026-04-29").tone).toBe("later");
  });

  it("'in Nw' for 14–60-day windows", () => {
    // 21 days out → 3 weeks.
    expect(relativeDue("2026-05-16").label).toBe("in 3w");
  });

  it("'Nd ago' / 'Nw ago' for past dates with overdue tone", () => {
    expect(relativeDue("2026-04-22").label).toBe("3d ago");
    expect(relativeDue("2026-04-22").tone).toBe("overdue");
    // 14 days back → 2 weeks.
    expect(relativeDue("2026-04-11").label).toBe("2w ago");
    expect(relativeDue("2026-04-11").tone).toBe("overdue");
  });

  it("falls back to the raw input when not a YYYY-MM-DD prefix", () => {
    const r = relativeDue("nonsense");
    expect(r.label).toBe("nonsense");
    expect(r.tone).toBe("later");
  });

  it("ignores the time portion of a YYYY-MM-DD HH:mm string", () => {
    expect(relativeDue("2026-04-25 09:30").label).toBe("today");
  });
});
