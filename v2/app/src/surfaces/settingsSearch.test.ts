import { describe, expect, it } from "vitest";

import { scoreSection } from "./Settings";

const APPEARANCE = {
  id: "general" as const,
  label: "General",
  keywords: ["appearance", "theme", "dark mode", "version"],
};

const DIAGNOSTICS = {
  id: "diagnostics" as const,
  label: "Diagnostics",
  keywords: ["ping", "keychain", "encryption"],
};

describe("scoreSection (B7-CP16 Settings search)", () => {
  it("returns 0 for an empty query", () => {
    expect(scoreSection(APPEARANCE, "")).toBe(0);
    expect(scoreSection(APPEARANCE, "   ")).toBe(0);
  });

  it("scores label match higher than keyword match", () => {
    const labelHit = scoreSection(APPEARANCE, "general");
    const keywordHit = scoreSection(APPEARANCE, "theme");
    expect(labelHit).toBeGreaterThan(keywordHit);
  });

  it("scores exact label > prefix > substring", () => {
    expect(scoreSection(APPEARANCE, "General")).toBeGreaterThan(
      scoreSection(APPEARANCE, "Gen"),
    );
    expect(scoreSection(APPEARANCE, "Gen")).toBeGreaterThan(
      scoreSection(APPEARANCE, "ral"),
    );
  });

  it("returns 0 when nothing matches label or any keyword", () => {
    expect(scoreSection(APPEARANCE, "completely-irrelevant")).toBe(0);
  });

  it("matches keywords across sections — 'ping' lands on Diagnostics", () => {
    const a = scoreSection(APPEARANCE, "ping");
    const d = scoreSection(DIAGNOSTICS, "ping");
    expect(d).toBeGreaterThan(0);
    expect(a).toBe(0);
  });

  it("is case-insensitive", () => {
    expect(scoreSection(APPEARANCE, "DARK MODE")).toBeGreaterThan(0);
    expect(scoreSection(APPEARANCE, "Theme")).toBeGreaterThan(0);
  });

  it("multi-word keywords match as phrases", () => {
    // "dark mode" is one of APPEARANCE's keywords; partial "dark"
    // hits the prefix branch.
    expect(scoreSection(APPEARANCE, "dark")).toBeGreaterThan(0);
    expect(scoreSection(APPEARANCE, "dark mode")).toBeGreaterThan(0);
  });
});
