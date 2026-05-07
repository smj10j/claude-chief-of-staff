import { describe, it, expect } from "vitest";

import { filterByPrefs, DEFAULT_PREFS } from "./velocityPrefs";

const PRS = [
  { author: "user-example", author_is_bot: false },
  { author: "dependabot[bot]", author_is_bot: true },
  { author: "renovate[bot]", author_is_bot: true },
  { author: "internal-bot", author_is_bot: false }, // not flagged by gh
];

describe("filterByPrefs", () => {
  it("hides bot-flagged authors by default", () => {
    const out = filterByPrefs(PRS, DEFAULT_PREFS);
    expect(out.map((r) => r.author)).toEqual([
      "user-example",
      "internal-bot",
    ]);
  });

  it("hides authors named in excludedAuthors even if not bot-flagged", () => {
    const out = filterByPrefs(PRS, {
      ...DEFAULT_PREFS,
      excludedAuthors: ["internal-bot"],
    });
    expect(out.map((r) => r.author)).toEqual(["user-example"]);
  });

  it("returns everything when showBots = true", () => {
    const out = filterByPrefs(PRS, { ...DEFAULT_PREFS, showBots: true });
    expect(out.length).toBe(4);
  });

  it("compares author logins case-insensitively", () => {
    const out = filterByPrefs(
      [{ author: "DependaBot[Bot]", author_is_bot: false }],
      { ...DEFAULT_PREFS, excludedAuthors: ["dependabot[bot]"] },
    );
    expect(out.length).toBe(0);
  });
});
