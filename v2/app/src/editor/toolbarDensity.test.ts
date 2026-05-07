// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";

import {
  readToolbarDensity,
  writeToolbarDensity,
} from "./EditorToolbar";

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
  clear(): void {
    this.map.clear();
  }
}

beforeEach(() => {
  (window as unknown as { localStorage: MemoryStorage }).localStorage =
    new MemoryStorage();
});

describe("toolbar density (B7-CP29)", () => {
  it("defaults to comfortable when nothing is stored", () => {
    expect(readToolbarDensity()).toBe("comfortable");
  });

  it("write/read round-trips", () => {
    writeToolbarDensity("compact");
    expect(readToolbarDensity()).toBe("compact");
    writeToolbarDensity("comfortable");
    expect(readToolbarDensity()).toBe("comfortable");
  });

  it("ignores unknown stored values and falls back to comfortable", () => {
    window.localStorage.setItem("cos.toolbar-density.v1", "ultra");
    expect(readToolbarDensity()).toBe("comfortable");
  });
});
