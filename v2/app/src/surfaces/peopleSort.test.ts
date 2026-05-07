import { describe, expect, it } from "vitest";

import { filterPeople, sortPeople, type PeopleSort } from "./People";
import { type PersonRef } from "./People";

const PEOPLE: PersonRef[] = [
  {
    slug: "alice",
    label: "Alice",
    relationship: "direct-reports",
    rel_path: "areas/one-on-ones/direct-reports/alice",
    has_readme: true,
    session_count: 12,
    last_session: "2026-04-25",
  },
  {
    slug: "bob",
    label: "Bob",
    relationship: "manager",
    rel_path: "areas/one-on-ones/manager/bob",
    has_readme: true,
    session_count: 30,
    last_session: "2026-04-22",
  },
  {
    slug: "aaron-salls",
    label: "Eve Jones",
    relationship: "peers",
    rel_path: "areas/one-on-ones/peers/aaron-salls",
    has_readme: true,
    session_count: 8,
    last_session: "2026-03-10",
  },
  {
    slug: "newcomer",
    label: "Newcomer",
    relationship: "direct-reports",
    rel_path: "areas/one-on-ones/direct-reports/newcomer",
    has_readme: false,
    session_count: 0,
    last_session: null,
  },
];

describe("filterPeople", () => {
  it("matches on label substring (case-insensitive)", () => {
    const hits = filterPeople(PEOPLE, "AaR");
    expect(hits.map((p) => p.slug)).toEqual(["aaron-salls"]);
  });

  it("matches on slug substring", () => {
    const hits = filterPeople(PEOPLE, "alice");
    expect(hits.map((p) => p.slug)).toEqual(["alice"]);
  });

  it("returns empty for empty / whitespace query", () => {
    expect(filterPeople(PEOPLE, "")).toEqual([]);
    expect(filterPeople(PEOPLE, "   ")).toEqual([]);
  });
});

describe("sortPeople", () => {
  function order(mode: PeopleSort): string[] {
    return sortPeople(PEOPLE, mode).map((p) => p.slug);
  }

  it("default 'last' ranks most-recent session first; null sessions go last", () => {
    expect(order("last")).toEqual([
      "alice", // 2026-04-25
      "bob", // 2026-04-22
      "aaron-salls", // 2026-03-10
      "newcomer", // null
    ]);
  });

  it("'name' is alphabetical regardless of session date", () => {
    expect(order("name")).toEqual([
      "aaron-salls",
      "alice",
      "newcomer",
      "bob",
    ]);
  });

  it("'staleness' floats null sessions to the top, then oldest dates", () => {
    expect(order("staleness")).toEqual([
      "newcomer", // null — most stale
      "aaron-salls", // 2026-03-10
      "bob", // 2026-04-22
      "alice", // 2026-04-25
    ]);
  });

  it("does not mutate the input array", () => {
    const before = [...PEOPLE].map((p) => p.slug);
    sortPeople(PEOPLE, "name");
    expect(PEOPLE.map((p) => p.slug)).toEqual(before);
  });

  it("breaks ties on label when both null in 'staleness' / 'last'", () => {
    const both: PersonRef[] = [
      { ...PEOPLE[3], slug: "z", label: "Z Person" },
      { ...PEOPLE[3], slug: "a", label: "A Person" },
    ];
    expect(sortPeople(both, "last").map((p) => p.slug)).toEqual(["a", "z"]);
    expect(sortPeople(both, "staleness").map((p) => p.slug)).toEqual([
      "a",
      "z",
    ]);
  });
});
