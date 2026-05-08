// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";

import {
  markFirstRunComplete,
  pickChallengePositions,
  shouldShowFirstRun,
} from "./InstallWizard";

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

describe("InstallWizard first-run gate", () => {
  it("shouldShowFirstRun returns true on a fresh machine", () => {
    expect(shouldShowFirstRun()).toBe(true);
  });

  it("markFirstRunComplete persists so shouldShowFirstRun returns false next call", () => {
    markFirstRunComplete();
    expect(shouldShowFirstRun()).toBe(false);
  });

  it("the persistence key is namespaced + versioned", () => {
    markFirstRunComplete();
    // We don't assert the exact key string (that's an impl detail),
    // but it should sit under a cos. prefix and include a version.
    const keys: string[] = [];
    const ms = window.localStorage as unknown as MemoryStorage;
    // Hack: peek into the map via a read.
    // Actually MemoryStorage doesn't expose iteration; use a proxy
    // approach by setting+reading a sentinel.
    // Simpler: just confirm shouldShowFirstRun flips after marking.
    void keys;
    expect(ms.getItem("cos.first-run-complete.v1")).toBe("true");
  });
});

describe("pickChallengePositions (M8b recovery challenge)", () => {
  it("returns exactly 4 positions", () => {
    expect(pickChallengePositions(1).length).toBe(4);
    expect(pickChallengePositions(99999).length).toBe(4);
  });

  it("never picks position 1 or 24 (avoids endpoints)", () => {
    for (let seed = 0; seed < 50; seed++) {
      const picks = pickChallengePositions(seed);
      for (const p of picks) {
        expect(p).toBeGreaterThanOrEqual(2);
        expect(p).toBeLessThanOrEqual(23);
      }
    }
  });

  it("returns positions in ascending order", () => {
    for (let seed = 0; seed < 50; seed++) {
      const picks = pickChallengePositions(seed);
      const sorted = [...picks].sort((a, b) => a - b);
      expect(picks).toEqual(sorted);
    }
  });

  it("returns four distinct positions", () => {
    for (let seed = 0; seed < 50; seed++) {
      const picks = pickChallengePositions(seed);
      expect(new Set(picks).size).toBe(4);
    }
  });

  it("is deterministic per seed (same seed → same picks)", () => {
    const a = pickChallengePositions(12345);
    const b = pickChallengePositions(12345);
    expect(a).toEqual(b);
  });

  it("varies across seeds", () => {
    // We're not asserting absolute distribution, just that two
    // different seeds don't always collide.
    let differing = 0;
    for (let seed = 0; seed < 30; seed++) {
      const a = pickChallengePositions(seed);
      const b = pickChallengePositions(seed + 100);
      if (a.join(",") !== b.join(",")) differing++;
    }
    expect(differing).toBeGreaterThan(20);
  });
});
