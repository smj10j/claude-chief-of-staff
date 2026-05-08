import { describe, expect, it } from "vitest";

import { findMatches } from "./findInDoc";

/**
 * Build a thin stub for the editor surface that findMatches needs:
 * `editor.state.doc.descendants(visit)`. Each visit is invoked with a
 * Tiptap-shaped node (`isText`, `text`) and a starting position.
 */
function fakeEditor(
  segments: Array<{ text: string; from: number }>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  return {
    state: {
      doc: {
        descendants(
          fn: (node: { isText: true; text: string }, pos: number) => void,
        ) {
          for (const seg of segments) {
            fn({ isText: true, text: seg.text }, seg.from);
          }
        },
      },
    },
  };
}

describe("findMatches", () => {
  it("finds case-insensitive substrings", () => {
    const editor = fakeEditor([{ text: "Hello world. hello again.", from: 1 }]);
    const m = findMatches(editor, "hello");
    expect(m).toEqual([
      { from: 1, to: 6 },
      { from: 14, to: 19 },
    ]);
  });

  it("returns empty for empty query", () => {
    const editor = fakeEditor([{ text: "anything", from: 1 }]);
    expect(findMatches(editor, "")).toEqual([]);
  });

  it("returns empty when editor is null", () => {
    expect(findMatches(null, "anything")).toEqual([]);
  });

  it("aggregates matches across multiple text nodes (paragraphs)", () => {
    const editor = fakeEditor([
      { text: "alpha one", from: 1 }, // 9 chars at 1..10
      { text: "beta one", from: 12 }, // 8 chars at 12..20
    ]);
    const m = findMatches(editor, "one");
    expect(m).toEqual([
      { from: 7, to: 10 },
      { from: 17, to: 20 },
    ]);
  });

  it("matches once when query equals the text", () => {
    const editor = fakeEditor([{ text: "Match", from: 5 }]);
    const m = findMatches(editor, "Match");
    expect(m).toEqual([{ from: 5, to: 10 }]);
  });

  it("does not return overlapping matches", () => {
    // "aaaa" vs query "aa" — non-overlapping yields 2, not 3.
    const editor = fakeEditor([{ text: "aaaa", from: 1 }]);
    const m = findMatches(editor, "aa");
    expect(m).toEqual([
      { from: 1, to: 3 },
      { from: 3, to: 5 },
    ]);
  });
});
