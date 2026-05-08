import { describe, expect, it } from "vitest";

import {
  isKnownCapability,
  KNOWN_PLUGIN_CAPABILITIES,
} from "./Settings";

describe("isKnownCapability (B7-CP21/CP22)", () => {
  it("recognizes the documented capabilities", () => {
    for (const cap of [
      "tasks.read",
      "tasks.write",
      "content.read",
      "content.write",
      "calendar.read",
      "claude.skills",
      "settings.read",
      "audit.read",
    ]) {
      expect(isKnownCapability(cap)).toBe(true);
    }
  });

  it("returns false for unknown / typo'd capabilities", () => {
    expect(isKnownCapability("tasks.delete")).toBe(false);
    expect(isKnownCapability("weather.read")).toBe(false);
    expect(isKnownCapability("")).toBe(false);
  });

  it("is case-sensitive — caps are dotted snake-case by convention", () => {
    expect(isKnownCapability("Tasks.Read")).toBe(false);
    expect(isKnownCapability("tasks.READ")).toBe(false);
  });

  it("KNOWN_PLUGIN_CAPABILITIES exposes the same set the function uses", () => {
    // Sanity: the public Set is what the helper consults.
    for (const cap of KNOWN_PLUGIN_CAPABILITIES) {
      expect(isKnownCapability(cap)).toBe(true);
    }
  });
});
