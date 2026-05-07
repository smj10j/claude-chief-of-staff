// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";

import {
  applyAccentOverride,
  normalizeAccentHex,
  readAccentOverride,
  writeAccentOverride,
} from "./registry";

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
  // Clear any prior inline accent so applyAccentOverride() tests are
  // isolated.
  document.documentElement.style.removeProperty("--cos-accent");
});

describe("normalizeAccentHex (B7-CP27)", () => {
  it("accepts 3-digit and 6-digit hex with leading #", () => {
    expect(normalizeAccentHex("#abc")).toBe("#abc");
    expect(normalizeAccentHex("#AaBbCc")).toBe("#aabbcc");
  });

  it("rejects strings without a leading #", () => {
    expect(normalizeAccentHex("abc")).toBeNull();
    expect(normalizeAccentHex("aabbcc")).toBeNull();
  });

  it("rejects non-hex characters", () => {
    expect(normalizeAccentHex("#abz")).toBeNull();
    expect(normalizeAccentHex("#aabbcg")).toBeNull();
  });

  it("rejects wrong-length hex strings", () => {
    expect(normalizeAccentHex("#")).toBeNull();
    expect(normalizeAccentHex("#ab")).toBeNull();
    expect(normalizeAccentHex("#abcd")).toBeNull();
    expect(normalizeAccentHex("#abcdefa")).toBeNull();
  });

  it("trims whitespace before validating", () => {
    expect(normalizeAccentHex("  #abc  ")).toBe("#abc");
  });
});

describe("readAccentOverride / writeAccentOverride round-trip", () => {
  it("returns null when nothing is stored", () => {
    expect(readAccentOverride()).toBeNull();
  });

  it("persists a normalized hex through round-trip", () => {
    writeAccentOverride("#7AA2F7");
    expect(readAccentOverride()).toBe("#7aa2f7");
  });

  it("writeAccentOverride(null) removes the key", () => {
    writeAccentOverride("#abc");
    expect(readAccentOverride()).toBe("#abc");
    writeAccentOverride(null);
    expect(readAccentOverride()).toBeNull();
  });

  it("rejects writes of malformed values rather than persisting them", () => {
    writeAccentOverride("not-a-color");
    expect(readAccentOverride()).toBeNull();
  });
});

describe("applyAccentOverride DOM effect", () => {
  it("sets --cos-accent on documentElement when given a valid hex", () => {
    applyAccentOverride("#abcdef");
    expect(
      document.documentElement.style.getPropertyValue("--cos-accent"),
    ).toBe("#abcdef");
  });

  it("clears --cos-accent on documentElement when given null", () => {
    applyAccentOverride("#abcdef");
    applyAccentOverride(null);
    expect(
      document.documentElement.style.getPropertyValue("--cos-accent"),
    ).toBe("");
  });

  it("does NOT set the property when given a malformed value", () => {
    applyAccentOverride("nope");
    expect(
      document.documentElement.style.getPropertyValue("--cos-accent"),
    ).toBe("");
  });
});
