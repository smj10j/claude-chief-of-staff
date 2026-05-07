import { describe, expect, it } from "vitest";

import { filterAnnotations } from "./AnnotationsPanel";
import { type AnnotationItem } from "./annotations";

const ITEMS: AnnotationItem[] = [
  {
    id: "a",
    text: "open one",
    comment: "needs follow-up",
    createdAt: "2026-04-25T10:00:00Z",
  },
  {
    id: "b",
    text: "another open",
    comment: "",
    createdAt: "2026-04-25T10:30:00Z",
  },
  {
    id: "c",
    text: "processed",
    comment: "applied",
    createdAt: "2026-04-25T09:00:00Z",
    processedAt: "2026-04-25T11:00:00Z",
  },
];

describe("filterAnnotations (B7-CP8)", () => {
  it("'open' returns only annotations without processedAt", () => {
    expect(filterAnnotations(ITEMS, "open").map((i) => i.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("'processed' returns only annotations with processedAt", () => {
    expect(filterAnnotations(ITEMS, "processed").map((i) => i.id)).toEqual([
      "c",
    ]);
  });

  it("'all' returns the unfiltered list in original order", () => {
    expect(filterAnnotations(ITEMS, "all").map((i) => i.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("returns empty when no items match the filter", () => {
    expect(filterAnnotations([], "open")).toEqual([]);
    expect(
      filterAnnotations(ITEMS.slice(2, 3), "open"), // only the processed one
    ).toEqual([]);
  });

  it("does not mutate the input list", () => {
    const before = ITEMS.map((i) => i.id);
    filterAnnotations(ITEMS, "open");
    expect(ITEMS.map((i) => i.id)).toEqual(before);
  });
});
