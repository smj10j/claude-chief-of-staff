// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";

import {
  clearRestoredStorage,
  loadRestoredFromStorage,
  saveRestoredToStorage,
  type RestoreOutcome,
} from "./Settings";

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) ?? null) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

beforeEach(() => {
  (window as unknown as { localStorage: MemoryStorage }).localStorage =
    new MemoryStorage();
});

describe("Settings restore-status localStorage", () => {
  it("returns an empty map when storage is unset", () => {
    expect(loadRestoredFromStorage().size).toBe(0);
  });

  it("persists and restores 'restored' outcomes", () => {
    saveRestoredToStorage(7, {
      kind: "restored",
      rel_path: "areas/x/y.md",
    });
    const map = loadRestoredFromStorage();
    expect(map.get(7)).toEqual({
      kind: "restored",
      rel_path: "areas/x/y.md",
    });
  });

  it("persists 'no_op' so a re-restore-then-tab-switch doesn't re-arm", () => {
    saveRestoredToStorage(11, { kind: "no_op", rel_path: "areas/y/z.md" });
    expect(loadRestoredFromStorage().get(11)).toEqual({
      kind: "no_op",
      rel_path: "areas/y/z.md",
    });
  });

  it("persists 'create_row' and 'blob_missing' so the user doesn't re-discover dead-end rows", () => {
    saveRestoredToStorage(20, { kind: "create_row" });
    saveRestoredToStorage(21, { kind: "blob_missing" });
    const map = loadRestoredFromStorage();
    expect(map.get(20)).toEqual({ kind: "create_row" });
    expect(map.get(21)).toEqual({ kind: "blob_missing" });
  });

  it("replaces a prior entry when the same id is saved twice", () => {
    saveRestoredToStorage(7, { kind: "blob_missing" });
    saveRestoredToStorage(7, { kind: "restored", rel_path: "x.md" });
    const map = loadRestoredFromStorage();
    expect(map.size).toBe(1);
    expect(map.get(7)).toEqual({ kind: "restored", rel_path: "x.md" });
  });

  it("clearRestoredStorage empties the persisted set", () => {
    saveRestoredToStorage(1, { kind: "restored", rel_path: "a.md" });
    saveRestoredToStorage(2, { kind: "create_row" });
    expect(loadRestoredFromStorage().size).toBe(2);
    clearRestoredStorage();
    expect(loadRestoredFromStorage().size).toBe(0);
  });

  it("survives malformed JSON gracefully", () => {
    window.localStorage.setItem("cos.restored-audit-ids.v2", "not json");
    expect(loadRestoredFromStorage().size).toBe(0);
  });

  it("filters out unknown outcome kinds during read", () => {
    window.localStorage.setItem(
      "cos.restored-audit-ids.v2",
      JSON.stringify([
        { id: 1, outcome: "restored", rel_path: "a.md" },
        { id: 2, outcome: "made-up-kind" },
      ]),
    );
    const map = loadRestoredFromStorage();
    expect(map.size).toBe(1);
    expect(map.get(1)).toEqual({ kind: "restored", rel_path: "a.md" });
    expect(map.get(2)).toBeUndefined();
  });

  it("saved entries round-trip across many writes without mutual interference", () => {
    const outcomes: { id: number; outcome: RestoreOutcome }[] = [
      { id: 1, outcome: { kind: "restored", rel_path: "a.md" } },
      { id: 2, outcome: { kind: "no_op", rel_path: "b.md" } },
      { id: 3, outcome: { kind: "create_row" } },
      { id: 4, outcome: { kind: "blob_missing" } },
    ];
    for (const o of outcomes) saveRestoredToStorage(o.id, o.outcome);
    const map = loadRestoredFromStorage();
    expect(map.size).toBe(4);
    expect(map.get(1)).toEqual({ kind: "restored", rel_path: "a.md" });
    expect(map.get(2)).toEqual({ kind: "no_op", rel_path: "b.md" });
    expect(map.get(3)).toEqual({ kind: "create_row" });
    expect(map.get(4)).toEqual({ kind: "blob_missing" });
  });
});
