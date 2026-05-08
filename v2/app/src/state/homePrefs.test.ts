import { describe, it, expect } from "vitest";

import {
  ALL_STRIPS,
  DEFAULT_HOME_PREFS,
  moveStrip,
  type HomeStripId,
} from "./homePrefs";

describe("moveStrip", () => {
  it("moves a strip up by one", () => {
    const out = moveStrip(["incidents", "needs-review", "oncall"], "needs-review", -1);
    expect(out).toEqual(["needs-review", "incidents", "oncall"]);
  });

  it("moves a strip down by one", () => {
    const out = moveStrip(["incidents", "needs-review", "oncall"], "needs-review", 1);
    expect(out).toEqual(["incidents", "oncall", "needs-review"]);
  });

  it("is a no-op at the top", () => {
    const out = moveStrip(["incidents", "oncall"], "incidents", -1);
    expect(out).toEqual(["incidents", "oncall"]);
  });

  it("is a no-op at the bottom", () => {
    const out = moveStrip(["incidents", "oncall"], "oncall", 1);
    expect(out).toEqual(["incidents", "oncall"]);
  });

  it("returns input unchanged when strip not present", () => {
    const out = moveStrip(["incidents"] as HomeStripId[], "oncall", 1);
    expect(out).toEqual(["incidents"]);
  });
});

describe("DEFAULT_HOME_PREFS / ALL_STRIPS", () => {
  it("default order matches ALL_STRIPS one-to-one", () => {
    expect(DEFAULT_HOME_PREFS.stripOrder).toEqual(ALL_STRIPS);
  });
});
