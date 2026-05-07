import { describe, expect, it } from "vitest";

import { inferDocContext } from "./docContext";

describe("inferDocContext", () => {
  it("infers People context from a 1:1 session path", () => {
    const ctx = inferDocContext(
      "areas/one-on-ones/direct-reports/alice/sessions/2026-05-06.md",
    );
    expect(ctx).not.toBeNull();
    expect(ctx!.surface).toBe("people");
    expect(ctx!.peopleProfile).toEqual({
      slug: "alice",
      label: "Alice",
      rel_path: "areas/one-on-ones/direct-reports/alice",
    });
    expect(ctx!.projectProfile).toBeNull();
    expect(ctx!.meetingProfile).toBeNull();
    expect(ctx!.crumbs).toHaveLength(1);
    expect(ctx!.crumbs[0]!.profile?.slug).toBe("alice");
  });

  it("infers People context from peers / skip-level subfolders too", () => {
    const peers = inferDocContext(
      "areas/one-on-ones/peers/aaron/sessions/2026-05-06.md",
    );
    expect(peers!.peopleProfile?.slug).toBe("aaron");

    const skip = inferDocContext(
      "areas/one-on-ones/skip-level-reports/henry/README.md",
    );
    expect(skip!.peopleProfile?.slug).toBe("henry");
  });

  it("infers Meetings context from a recurring-meeting session", () => {
    const ctx = inferDocContext(
      "areas/meetings/payments-eng-leadership/sessions/2026-05-06.md",
    );
    expect(ctx!.surface).toBe("meetings");
    expect(ctx!.meetingProfile).toEqual({
      slug: "payments-eng-leadership",
      label: "Payments Eng Leadership",
      rel_path: "areas/meetings/payments-eng-leadership",
    });
    expect(ctx!.crumbs[0]!.meeting?.slug).toBe("payments-eng-leadership");
  });

  it("infers Projects context from a project file at any depth", () => {
    const top = inferDocContext("projects/payments-eng-strategy/index.html");
    expect(top!.surface).toBe("projects");
    expect(top!.projectProfile?.slug).toBe("payments-eng-strategy");

    const nested = inferDocContext(
      "projects/payments-eng-strategy/subdir/notes.md",
    );
    expect(nested!.projectProfile?.slug).toBe("payments-eng-strategy");
  });

  it("tolerates a leading data/files/ prefix (defensive)", () => {
    const ctx = inferDocContext(
      "data/files/areas/one-on-ones/direct-reports/alice/sessions/2026-05-06.md",
    );
    expect(ctx!.peopleProfile?.slug).toBe("alice");
    expect(ctx!.peopleProfile?.rel_path).toBe(
      "areas/one-on-ones/direct-reports/alice",
    );
  });

  it("returns null for paths outside the recognized hierarchies", () => {
    expect(inferDocContext("inbox.md")).toBeNull();
    expect(inferDocContext("areas/career/leveling.md")).toBeNull();
    expect(inferDocContext("README.md")).toBeNull();
    expect(inferDocContext("")).toBeNull();
  });

  it("returns null when the slug segment is missing", () => {
    expect(inferDocContext("areas/one-on-ones/direct-reports/")).toBeNull();
    expect(inferDocContext("areas/meetings/")).toBeNull();
    expect(inferDocContext("projects/")).toBeNull();
  });
});
