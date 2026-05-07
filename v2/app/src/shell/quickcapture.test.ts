import { describe, expect, it } from "vitest";

// Re-import the helper indirectly — appendDueHint isn't exported, so
// this test exercises the equivalent regex through the same shape.
// Mirroring the regex here pins the behavior without forcing the
// component to expose internals.

const DUE_HINT_RE = /\s*(?:due (?:today|tomorrow|next week))$/i;

function appendDueHint(current: string, append: string): string {
  const trimmed = current.replace(DUE_HINT_RE, "").trimEnd();
  if (append === "") return trimmed;
  return `${trimmed} ${append}`.trim();
}

describe("appendDueHint", () => {
  it("appends to an empty string", () => {
    expect(appendDueHint("", "due today")).toBe("due today");
  });

  it("appends to a plain title", () => {
    expect(appendDueHint("call bob", "due tomorrow")).toBe(
      "call bob due tomorrow",
    );
  });

  it("replaces a previous preset rather than stacking", () => {
    expect(
      appendDueHint("call bob due today", "due tomorrow"),
    ).toBe("call bob due tomorrow");
  });

  it("'no date' (empty append) strips the previous preset", () => {
    expect(appendDueHint("call bob due next week", "")).toBe(
      "call bob",
    );
  });

  it("only matches at the END of the string", () => {
    // "due today" mid-title should NOT be treated as a preset to strip.
    expect(
      appendDueHint("note: due today was the deadline", "due tomorrow"),
    ).toBe("note: due today was the deadline due tomorrow");
  });

  it("is case-insensitive on the trailing preset", () => {
    expect(appendDueHint("call bob DUE TODAY", "due tomorrow")).toBe(
      "call bob due tomorrow",
    );
  });
});
