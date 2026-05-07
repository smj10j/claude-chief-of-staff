import { describe, expect, it } from "vitest";

import {
  countDiff,
  renderEditDiff,
  renderMultiEditDiff,
  renderWriteDiff,
} from "./diffPreview";

describe("renderEditDiff", () => {
  it("renders an old → new pair", () => {
    const { lines, filePath } = renderEditDiff({
      file_path: "/x.txt",
      old_string: "foo\nbar",
      new_string: "foo\nbaz",
    });
    expect(filePath).toBe("/x.txt");
    expect(lines).toEqual([
      { kind: "del", text: "foo" },
      { kind: "del", text: "bar" },
      { kind: "add", text: "foo" },
      { kind: "add", text: "baz" },
    ]);
  });

  it("handles missing fields", () => {
    const { lines, filePath } = renderEditDiff({});
    expect(filePath).toBeNull();
    // Empty strings split into a single empty line each.
    expect(lines).toHaveLength(2);
  });
});

describe("renderWriteDiff", () => {
  it("renders all lines as additions", () => {
    const { lines, filePath } = renderWriteDiff({
      file_path: "/y.txt",
      content: "alpha\nbeta\ngamma",
    });
    expect(filePath).toBe("/y.txt");
    expect(lines).toEqual([
      { kind: "add", text: "alpha" },
      { kind: "add", text: "beta" },
      { kind: "add", text: "gamma" },
    ]);
  });
});

describe("renderMultiEditDiff", () => {
  it("renders each edit pair separated by a meta line", () => {
    const { lines } = renderMultiEditDiff({
      file_path: "/z.txt",
      edits: [
        { old_string: "a", new_string: "A" },
        { old_string: "b", new_string: "B" },
      ],
    });
    expect(lines).toEqual([
      { kind: "del", text: "a" },
      { kind: "add", text: "A" },
      { kind: "meta", text: "—" },
      { kind: "del", text: "b" },
      { kind: "add", text: "B" },
    ]);
  });
});

describe("countDiff", () => {
  it("counts adds + removes, ignoring meta", () => {
    const { added, removed } = countDiff([
      { kind: "del", text: "x" },
      { kind: "del", text: "y" },
      { kind: "add", text: "z" },
      { kind: "meta", text: "—" },
    ]);
    expect(added).toBe(1);
    expect(removed).toBe(2);
  });
});
