import { describe, expect, it } from "vitest";

import { badgeForSurface } from "./Sidebar";
import { SURFACES } from "../state/surfaces";

const ZERO = {
  overdueTasks: 0,
  pendingAnnotations: 0,
  reviewRequests: 0,
  activeIncidents: 0,
  consoleUnseen: 0,
};

describe("badgeForSurface (B7-CP26 + B8-CP31)", () => {
  it("Tasks surface shows overdue + review-request count combined", () => {
    expect(
      badgeForSurface("work", {
        overdueTasks: 7,
        pendingAnnotations: 3,
        reviewRequests: 2,
        activeIncidents: 0,
        consoleUnseen: 0,
      }),
    ).toBe(9);
  });

  it("Home surface shows pending annotation count", () => {
    expect(
      badgeForSurface("home", {
        overdueTasks: 7,
        pendingAnnotations: 3,
        reviewRequests: 0,
        activeIncidents: 0,
        consoleUnseen: 0,
      }),
    ).toBe(3);
  });

  it("Ops surface shows active SEV-1/SEV-2 incidents", () => {
    expect(
      badgeForSurface("ops", {
        overdueTasks: 0,
        pendingAnnotations: 0,
        reviewRequests: 0,
        activeIncidents: 4,
        consoleUnseen: 0,
      }),
    ).toBe(4);
  });

  it("returns 0 for surfaces without a defined badge", () => {
    for (const surface of [
      "calendar",
      "people",
      "meetings",
      "projects",
      "settings",
    ] as const) {
      expect(badgeForSurface(surface, ZERO)).toBe(0);
    }
  });

  it("Console surface shows the unseen-completion pip from chat tabs", () => {
    expect(
      badgeForSurface("console", {
        overdueTasks: 0,
        pendingAnnotations: 0,
        reviewRequests: 0,
        activeIncidents: 0,
        consoleUnseen: 3,
      }),
    ).toBe(3);
  });

  it("zero counts mean no badge — Tasks/Home/Ops all render 0 in steady state", () => {
    expect(badgeForSurface("work", ZERO)).toBe(0);
    expect(badgeForSurface("home", ZERO)).toBe(0);
    expect(badgeForSurface("ops", ZERO)).toBe(0);
  });

  it("every surface in SURFACES has a defined badge mapping (no crashes)", () => {
    for (const s of SURFACES) {
      expect(typeof badgeForSurface(s.id, ZERO)).toBe("number");
    }
  });
});
