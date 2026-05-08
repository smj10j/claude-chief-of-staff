import { describe, expect, it } from "vitest";

import { resolveRelativePath } from "./resolveRelativePath";

describe("resolveRelativePath", () => {
  it("resolves a simple ./sibling", () => {
    expect(
      resolveRelativePath(
        "areas/one-on-ones/peers/aaron/README.md",
        "./sessions/2026-04-22.md",
      ),
    ).toBe("areas/one-on-ones/peers/aaron/sessions/2026-04-22.md");
  });

  it("resolves ../parent paths", () => {
    expect(
      resolveRelativePath(
        "areas/one-on-ones/peers/aaron/README.md",
        "../alex/README.md",
      ),
    ).toBe("areas/one-on-ones/peers/alex/README.md");
  });

  it("resolves multiple ../ chains", () => {
    expect(
      resolveRelativePath(
        "areas/one-on-ones/peers/aaron/sessions/2026-04-22.md",
        "../../alex/sessions/2026-04-23.md",
      ),
    ).toBe("areas/one-on-ones/peers/alex/sessions/2026-04-23.md");
  });

  it("treats bare filename as same-dir reference", () => {
    expect(
      resolveRelativePath(
        "projects/alpha/README.md",
        "metrics.md",
      ),
    ).toBe("projects/alpha/metrics.md");
  });

  it("returns null when relative path escapes content root", () => {
    expect(
      resolveRelativePath(
        "areas/x/y.md",
        "../../../../../etc/passwd",
      ),
    ).toBeNull();
  });

  it("returns null for empty inputs", () => {
    expect(resolveRelativePath("", "x.md")).toBeNull();
    expect(resolveRelativePath("a/b.md", "")).toBeNull();
  });

  it("collapses '.' segments without changing path", () => {
    expect(
      resolveRelativePath("a/b/c.md", "./././d.md"),
    ).toBe("a/b/d.md");
  });
});
