import { describe, it, expect } from "vitest";

import {
  DEFAULT_OPS_PREFS,
  formatTeamServices,
  isMineByKeywords,
  parseTeamServices,
  resolveMyPolicyKeywords,
} from "./opsPrefs";

describe("parseTeamServices", () => {
  it("parses one line per team with comma-separated services", () => {
    const out = parseTeamServices(
      `payments-core: pay-svc, ledger-svc\npayments-atwork: dte-svc`,
    );
    expect(out).toEqual({
      "payments-core": ["pay-svc", "ledger-svc"],
      "payments-atwork": ["dte-svc"],
    });
  });

  it("ignores blank lines and # comments", () => {
    const out = parseTeamServices(
      `# my map\n\npayments-core: pay-svc\n  \n# trailing`,
    );
    expect(Object.keys(out)).toEqual(["payments-core"]);
  });

  it("round-trips via format/parse", () => {
    const map = { team1: ["a", "b"], team2: ["c"] };
    expect(parseTeamServices(formatTeamServices(map))).toEqual(map);
  });
});

describe("resolveMyPolicyKeywords (B9-CP41)", () => {
  it("prefers explicit myPolicyKeywords when set", () => {
    expect(
      resolveMyPolicyKeywords({
        ...DEFAULT_OPS_PREFS,
        myTeam: "Payments Eng",
        myPolicyKeywords: ["dder", "dte"],
      }),
    ).toEqual(["dder", "dte"]);
  });

  it("falls back to splitting myTeam on whitespace when keywords are empty", () => {
    expect(
      resolveMyPolicyKeywords({
        ...DEFAULT_OPS_PREFS,
        myTeam: "Payments Core",
      }),
    ).toEqual(["payments", "core"]);
  });

  it("drops short tokens from the fallback so 'a' doesn't match everything", () => {
    expect(
      resolveMyPolicyKeywords({
        ...DEFAULT_OPS_PREFS,
        myTeam: "a b payments",
      }),
    ).toEqual(["payments"]);
  });

  it("returns an empty list when both myTeam and keywords are empty", () => {
    expect(resolveMyPolicyKeywords(DEFAULT_OPS_PREFS)).toEqual([]);
  });
});

describe("isMineByKeywords (B9-CP41)", () => {
  it("matches case-insensitively across any haystack", () => {
    expect(
      isMineByKeywords(
        ["Payments Core", "Primary Schedule", "Alice Smith"],
        ["payments"],
      ),
    ).toBe(true);
    expect(
      isMineByKeywords(
        ["Server API", "Primary", "Alice Smith"],
        ["alice"],
      ),
    ).toBe(true);
  });

  it("does not match when no keyword appears anywhere", () => {
    expect(
      isMineByKeywords(["Server API", "Primary", "Other Person"], ["payments"]),
    ).toBe(false);
  });

  it("returns false when keywords list is empty (avoids matching everything)", () => {
    expect(isMineByKeywords(["Payments Core"], [])).toBe(false);
  });

  it("ignores nullish haystacks", () => {
    expect(
      isMineByKeywords([null, undefined, "Payments Core"], ["payments"]),
    ).toBe(true);
  });
});
