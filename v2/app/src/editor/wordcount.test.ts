import { describe, expect, it } from "vitest";

import { countWords, readMinutesFor } from "./DocEditor";

describe("countWords", () => {
  it("returns 0 for empty + whitespace-only strings", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   \n\t ")).toBe(0);
  });

  it("counts simple ASCII words", () => {
    expect(countWords("hello world")).toBe(2);
    expect(countWords("a b c d e")).toBe(5);
  });

  it("collapses runs of whitespace", () => {
    expect(countWords("hello   world\n\nagain")).toBe(3);
  });

  it("counts hyphenated as one word (whitespace-split semantics)", () => {
    expect(countWords("state-of-the-art editor")).toBe(2);
  });
});

describe("readMinutesFor", () => {
  it("returns 0 for 0 words", () => {
    expect(readMinutesFor(0)).toBe(0);
  });

  it("rounds up to 1 for tiny non-zero counts (200 wpm baseline)", () => {
    expect(readMinutesFor(50)).toBe(1);
    expect(readMinutesFor(199)).toBe(1);
  });

  it("scales linearly past the first minute", () => {
    expect(readMinutesFor(400)).toBe(2);
    expect(readMinutesFor(1_000)).toBe(5);
  });
});
