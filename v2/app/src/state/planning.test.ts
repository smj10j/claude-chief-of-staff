import { describe, it, expect } from "vitest";

import { epicHealth, isEpicStale } from "./planning";

const NOW = Date.parse("2026-04-25T12:00:00Z");

describe("epicHealth", () => {
  it("flags red when any ticket is blocked", () => {
    expect(
      epicHealth(
        { tickets_total: 10, tickets_done: 5, tickets_blocked: 1 },
        NOW,
      ),
    ).toBe("red");
  });

  it("flags red when due date is past", () => {
    expect(
      epicHealth(
        {
          tickets_total: 10,
          tickets_done: 5,
          tickets_blocked: 0,
          due: "2026-04-01",
          updated: "2026-04-25T11:00:00Z",
        },
        NOW,
      ),
    ).toBe("red");
  });

  it("flags red when stale > 21 days", () => {
    expect(
      epicHealth(
        {
          tickets_total: 5,
          tickets_done: 1,
          updated: "2026-03-01T00:00:00Z",
        },
        NOW,
      ),
    ).toBe("red");
  });

  it("flags amber when due-soon and <70% done", () => {
    expect(
      epicHealth(
        {
          tickets_total: 10,
          tickets_done: 5,
          due: "2026-05-01",
          updated: "2026-04-25T11:00:00Z",
        },
        NOW,
      ),
    ).toBe("amber");
  });

  it("flags amber when <30% done with no due pressure", () => {
    expect(
      epicHealth(
        {
          tickets_total: 10,
          tickets_done: 2,
          updated: "2026-04-25T11:00:00Z",
        },
        NOW,
      ),
    ).toBe("amber");
  });

  it("returns green for a healthy in-flight epic", () => {
    expect(
      epicHealth(
        {
          tickets_total: 10,
          tickets_done: 7,
          updated: "2026-04-25T10:00:00Z",
        },
        NOW,
      ),
    ).toBe("green");
  });

  it("returns unknown when no data is available", () => {
    expect(epicHealth({}, NOW)).toBe("unknown");
  });
});

describe("isEpicStale", () => {
  it("flags >14d as stale", () => {
    expect(isEpicStale("2026-04-01T00:00:00Z", NOW)).toBe(true);
  });
  it("does not flag fresh epics", () => {
    expect(isEpicStale("2026-04-20T00:00:00Z", NOW)).toBe(false);
  });
  it("safely handles missing updated", () => {
    expect(isEpicStale(undefined, NOW)).toBe(false);
  });
});
