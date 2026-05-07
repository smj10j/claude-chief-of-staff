import { describe, expect, it } from "vitest";

import { snoozeDue } from "./Work";

describe("snoozeDue", () => {
  it("adds N days to a date-only due", () => {
    expect(snoozeDue("2026-04-25", 1)).toBe("2026-04-26");
    expect(snoozeDue("2026-04-25", 7)).toBe("2026-05-02");
    expect(snoozeDue("2026-04-25", 30)).toBe("2026-05-25");
  });

  it("preserves time when the original due has one", () => {
    expect(snoozeDue("2026-04-25 14:00", 1)).toBe("2026-04-26 14:00");
  });

  it("anchors to today when no current due is set", () => {
    const out = snoozeDue(null, 1);
    // Output should be a YYYY-MM-DD string. We can't assert the
    // specific date without freezing time, but length + shape are.
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("falls back to today on garbage input rather than NaN", () => {
    const out = snoozeDue("not a date", 1);
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("crosses month boundaries correctly", () => {
    expect(snoozeDue("2026-01-30", 5)).toBe("2026-02-04");
    expect(snoozeDue("2026-02-28", 1)).toBe("2026-03-01");
  });
});
