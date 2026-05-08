import { describe, expect, it } from "vitest";

import { gridRangeFor } from "./Calendar";

describe("gridRangeFor (B7-CP13 week-offset math)", () => {
  // Pinning to noon avoids any DST edges nudging the day rollover.
  const NOW = new Date(2026, 3, 25, 12, 0, 0); // 2026-04-25, April = month 3

  it("offset 0 → today through today+6", () => {
    expect(gridRangeFor(NOW, 0)).toEqual({
      fromIso: "2026-04-25",
      toIso: "2026-05-01",
    });
  });

  it("offset +1 → starts 7 days later, still 7-day window", () => {
    expect(gridRangeFor(NOW, 1)).toEqual({
      fromIso: "2026-05-02",
      toIso: "2026-05-08",
    });
  });

  it("offset -1 → starts 7 days earlier", () => {
    expect(gridRangeFor(NOW, -1)).toEqual({
      fromIso: "2026-04-18",
      toIso: "2026-04-24",
    });
  });

  it("crosses month + year boundaries cleanly", () => {
    const dec = new Date(2026, 11, 30, 12, 0, 0); // 2026-12-30
    expect(gridRangeFor(dec, 1)).toEqual({
      fromIso: "2027-01-06",
      toIso: "2027-01-12",
    });
  });

  it("does not mutate the input Date", () => {
    const before = new Date(NOW);
    gridRangeFor(NOW, 5);
    expect(NOW.getTime()).toBe(before.getTime());
  });
});
