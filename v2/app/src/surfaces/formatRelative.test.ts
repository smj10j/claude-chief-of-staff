import { describe, expect, it, vi, afterEach } from "vitest";

import { formatRelative } from "./Work";

describe("formatRelative", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns '—' for empty input", () => {
    expect(formatRelative("")).toBe("—");
  });

  it("returns 'just now' for sub-minute deltas", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T12:00:00Z"));
    // 20s ago rounds to 0 minutes via Math.round(20000/60000).
    expect(formatRelative("2026-04-25T11:59:40Z")).toBe("just now");
  });

  it("returns 'Nm ago' for minute deltas", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T12:00:00Z"));
    expect(formatRelative("2026-04-25T11:45:00Z")).toBe("15m ago");
  });

  it("returns 'Nh ago' for hour deltas", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T12:00:00Z"));
    expect(formatRelative("2026-04-25T08:00:00Z")).toBe("4h ago");
  });

  it("returns 'Nd ago' for day deltas", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T12:00:00Z"));
    expect(formatRelative("2026-04-22T12:00:00Z")).toBe("3d ago");
  });

  it("falls back to a locale date for >= 30d deltas", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T12:00:00Z"));
    const out = formatRelative("2025-12-01T00:00:00Z");
    expect(out).not.toContain("ago");
    // Different locales render differently; check non-empty.
    expect(out.length).toBeGreaterThan(0);
  });

  it("returns the input for unparseable strings", () => {
    expect(formatRelative("not-a-date")).toBe("not-a-date");
  });
});
