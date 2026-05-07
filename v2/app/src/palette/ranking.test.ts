import { describe, expect, it } from "vitest";

import {
  buildEntries,
  rank,
  type PaletteContext,
  type PaletteEntry,
} from "./ranking";

const noopCtx: PaletteContext = {
  setSurface: () => {},
  toggleSidebar: () => {},
  toggleSidePanel: () => {},
  openDoc: () => {},
  goToTask: () => {},
  goToProfile: () => {},
  goToMeeting: () => {},
  goToProject: () => {},
  switchToTab: () => {},
};

const ENTRIES = buildEntries(noopCtx);

function idsFor(query: string, recent: string[] = []): string[] {
  return rank(ENTRIES, query, recent).map((r) => r.entry.id);
}

describe("palette ranking — Open tabs section (PRD-v2-117 §4.9)", () => {
  it("on empty query, tab entries surface above views/commands", () => {
    const tabA: PaletteEntry = {
      id: "tab:a",
      kind: "tab",
      label: "Alice · 2026-04-22",
      tabIndex: 1,
      run: () => {},
    };
    const tabB: PaletteEntry = {
      id: "tab:b",
      kind: "tab",
      label: "Payments strategy",
      tabIndex: 2,
      run: () => {},
    };
    const ids = rank([...ENTRIES, tabA, tabB], "", []).map(
      (r) => r.entry.id,
    );
    expect(ids[0]).toBe("tab:a");
    expect(ids[1]).toBe("tab:b");
  });

  it("active query — a tab whose label matches outranks plain commands", () => {
    const tabA: PaletteEntry = {
      id: "tab:a",
      kind: "tab",
      label: "Alice 1:1",
      tabIndex: 1,
      run: () => {},
    };
    const ranked = rank([...ENTRIES, tabA], "Alice", []);
    expect(ranked[0]!.entry.id).toBe("tab:a");
  });
});

describe("palette ranking", () => {
  it("empty query shows all entries, recents first", () => {
    const ids = idsFor("", ["view:settings", "view:people"]);
    expect(ids[0]).toBe("view:settings");
    expect(ids[1]).toBe("view:people");
    expect(ids).toContain("view:home");
  });

  it("empty query without recents sorts alphabetically by id", () => {
    const ids = idsFor("");
    // Expect commands to interleave with views alphabetically by id.
    // After B8-CP32 the cmd:* family grew tab-jumps; the leading
    // entries are still command ids in lexical order.
    expect(ids[0]?.startsWith("cmd:")).toBe(true);
    expect(ids[1]?.startsWith("cmd:")).toBe(true);
    expect(ids).toContain("cmd:toggle-side-panel");
    expect(ids).toContain("cmd:toggle-sidebar");
    expect(ids).toContain("cmd:ops:health");
  });

  it("exact prefix match beats substring match", () => {
    // "tasks" is an exact prefix of the Tasks surface label. Surface
    // id stays "work" for backwards compat, label is the user-facing
    // string.
    const ids = idsFor("tasks");
    expect(ids[0]).toBe("view:work");
  });

  it("case-insensitive", () => {
    expect(idsFor("TASKS")[0]).toBe("view:work");
    expect(idsFor("TaSkS")[0]).toBe("view:work");
  });

  it("label substring beats hint-only match", () => {
    // "people" is in the People label directly, but also in some hints.
    // Verify the direct label match ranks first.
    const ids = idsFor("people");
    expect(ids[0]).toBe("view:people");
  });

  it("hint match returns an entry when label doesn't match", () => {
    // "tree" is only in the People description hint.
    const ids = idsFor("tree");
    expect(ids).toContain("view:people");
  });

  it("recent boost cannot outrank an exact prefix of a different entry", () => {
    // "set" is an exact prefix of Settings.
    // Mark Home as recent. It only matches via hint if at all — should NOT
    // surface above Settings.
    const ids = idsFor("set", ["view:home"]);
    expect(ids[0]).toBe("view:settings");
  });

  it("no matches returns an empty list", () => {
    expect(idsFor("zzzzzzzz")).toEqual([]);
  });

  it("tiebreaker is alphabetical by id", () => {
    // "toggle" matches both toggle commands.
    const ids = idsFor("toggle");
    const toggleIds = ids.filter((id) => id.startsWith("cmd:toggle-"));
    expect(toggleIds).toEqual([
      "cmd:toggle-side-panel",
      "cmd:toggle-sidebar",
    ]);
  });

  // Tasks and docs are added to the entry list dynamically by the
  // palette when it loads. Test the ranker behavior with a synthetic
  // task entry mixed into the base set.
  function withTask(label: string): PaletteEntry[] {
    return [
      ...ENTRIES,
      {
        id: `task:t1`,
        kind: "task",
        label,
        run: () => {},
      },
    ];
  }

  it("task entries are hidden when the query is empty", () => {
    const r = rank(withTask("Buy milk"), "", []);
    expect(r.map((x) => x.entry.id)).not.toContain("task:t1");
  });

  it("entity entries (person/meeting/project) hide on empty query and surface on substring match", () => {
    const personEntry: PaletteEntry = {
      id: "person:alice",
      kind: "person",
      label: "Alice",
      hint: "direct reports",
      run: () => {},
    };
    const meetingEntry: PaletteEntry = {
      id: "meeting:team-eng-leads",
      kind: "meeting",
      label: "Team Eng Leads",
      hint: "recurring meeting",
      run: () => {},
    };
    const projectEntry: PaletteEntry = {
      id: "project:alpha-launch",
      kind: "project",
      label: "Alpha Launch",
      hint: "project",
      run: () => {},
    };
    const all = [...ENTRIES, personEntry, meetingEntry, projectEntry];

    // Empty query: entity entries are hidden (alongside tasks).
    const empty = rank(all, "", []).map((r) => r.entry.id);
    expect(empty).not.toContain(personEntry.id);
    expect(empty).not.toContain(meetingEntry.id);
    expect(empty).not.toContain(projectEntry.id);

    // Active query matches by label substring.
    expect(rank(all, "aash", []).map((r) => r.entry.id)).toContain(
      personEntry.id,
    );
    expect(rank(all, "payments", []).map((r) => r.entry.id)).toContain(
      meetingEntry.id,
    );
    expect(rank(all, "alpha", []).map((r) => r.entry.id)).toContain(
      projectEntry.id,
    );
  });

  it("doc entries surface on the empty-query path (recent docs)", () => {
    const recentDoc: PaletteEntry = {
      id: "doc:areas/one-on-ones/manager/bob/README.md",
      kind: "doc",
      label: "Bob README",
      hint: "recent",
      run: () => {},
    };
    const r = rank([...ENTRIES, recentDoc], "", []);
    const ids = r.map((x) => x.entry.id);
    expect(ids).toContain(recentDoc.id);
    // Doc entries come AFTER all views/commands so they don't push the
    // primary navigation off the top of the palette.
    const docIdx = ids.indexOf(recentDoc.id);
    const lastNonDocIdx = ids.findIndex((id) => id.startsWith("doc:")) - 1;
    expect(docIdx).toBeGreaterThan(lastNonDocIdx);
    for (let i = 0; i < docIdx; i++) {
      expect(ids[i].startsWith("doc:")).toBe(false);
    }
  });

  it("task entries match by title substring", () => {
    const r = rank(withTask("Buy milk for office"), "milk", []);
    expect(r.map((x) => x.entry.id)).toContain("task:t1");
  });

  it("task entries with exact prefix beat substring matches in unrelated views", () => {
    const r = rank(withTask("People sync prep"), "people", []);
    // view:people exists with label "People" — exact prefix at 90 ought
    // to beat the task's substring score at 60.
    expect(r[0]?.entry.id).toBe("view:people");
  });
});
