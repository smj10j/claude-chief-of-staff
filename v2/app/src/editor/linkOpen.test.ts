import { describe, expect, it } from "vitest";

import { ensureDocPath } from "./linkOpen";

describe("ensureDocPath", () => {
  it("leaves explicit .md targets alone", () => {
    expect(ensureDocPath("projects/x/README.md")).toBe(
      "projects/x/README.md",
    );
    expect(ensureDocPath("areas/one-on-ones/alice/sessions/2026-04-25.md"))
      .toBe("areas/one-on-ones/alice/sessions/2026-04-25.md");
  });

  it("appends README.md to folder-style paths", () => {
    expect(ensureDocPath("projects/example-project")).toBe(
      "projects/example-project/README.md",
    );
    expect(ensureDocPath("projects/example-project/")).toBe(
      "projects/example-project/README.md",
    );
  });

  it("handles empty input", () => {
    expect(ensureDocPath("")).toBe("");
  });
});
