import { describe, expect, it } from "vitest";

import { auditRowCopyPayload } from "./Settings";

const ROW = {
  id: 42,
  at: "2026-04-25T10:00:00.000Z",
  actor: "local",
  action: "doc.write",
  target_kind: "doc",
  target_id: "areas/one-on-ones/manager/bob/README.md",
  detail_json: JSON.stringify({ before_hash: "abc", after_hash: "def" }),
  this_hash: "deadbeef",
};

describe("auditRowCopyPayload (B6-CP3)", () => {
  it("includes every visible row field plus the parsed detail", () => {
    const payload = auditRowCopyPayload(ROW, { foo: "bar" });
    expect(payload).toEqual({
      id: 42,
      at: "2026-04-25T10:00:00.000Z",
      actor: "local",
      action: "doc.write",
      target_kind: "doc",
      target_id: "areas/one-on-ones/manager/bob/README.md",
      this_hash: "deadbeef",
      detail: { foo: "bar" },
    });
  });

  it("does NOT include the raw detail_json string (we already parsed it)", () => {
    const payload = auditRowCopyPayload(ROW, { x: 1 });
    expect("detail_json" in payload).toBe(false);
  });

  it("nests an empty detail object when nothing was parsed", () => {
    const payload = auditRowCopyPayload(ROW, {});
    expect(payload.detail).toEqual({});
  });

  it("serializes cleanly to JSON (no circular refs / undefined leakage)", () => {
    const payload = auditRowCopyPayload(ROW, { hash: "abc" });
    expect(() => JSON.stringify(payload)).not.toThrow();
    const round = JSON.parse(JSON.stringify(payload));
    expect(round.id).toBe(42);
    expect(round.detail.hash).toBe("abc");
  });
});
