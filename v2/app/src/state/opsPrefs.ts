/**
 * Ops surface prefs (B8-CP21). PRD-108 §3 #10: a manual service →
 * team map for orgs without a queryable service catalogue. Stored
 * locally; tabs read it to filter "my team's services" once Ops
 * grows that filter (post-B8).
 */

const KEY = "cos:ops-prefs";

export type DeployEntry = {
  service: string;
  url?: string;
  /** Optional ISO timestamp; falls back to manual order in the
   *  list when missing. */
  at?: string;
  /** Free text — version / commit sha / who shipped it. */
  note?: string;
};

export type OpsPrefs = {
  /** Team the user identifies as belonging to. Used to default the
   *  "my services" filter on Health. */
  myTeam: string;
  /** Map of team name → list of service names owned by that team.
   *  Used by Health to scope Rollbar / Datadog rows once filters
   *  land. */
  teamServices: Record<string, string[]>;
  /** PagerDuty service id (`P…`) the manager wants pinned to the
   *  Home on-call strip + Health detail panel (B9-CP6). One per
   *  workspace; the user might own several services but we only
   *  surface one on Home to keep noise down. Empty string = unset. */
  homeServiceId: string;
  /** Optional human label for the pinned service. Falls back to
   *  the PD service summary on the Health detail. */
  homeServiceLabel: string;
  /** B9-CP26 — manual list of recent deploys. Phase-0 placeholder
   *  until the Compass adapter (or equivalent) lands; today users
   *  paste a few rows here and the Ops Health → Deploys section
   *  renders them. */
  recentDeploys: DeployEntry[];
  /** Case-insensitive substrings used by the On-call tab (and any
   *  future Ops surface) to decide which escalation policies belong
   *  to "my teams". A policy / schedule / on-call user matches when
   *  any keyword appears as a substring of its name. Empty array
   *  falls back to splitting `myTeam` on whitespace. */
  myPolicyKeywords: string[];
};

export const DEFAULT_OPS_PREFS: OpsPrefs = {
  myTeam: "",
  teamServices: {},
  homeServiceId: "",
  homeServiceLabel: "",
  recentDeploys: [],
  myPolicyKeywords: [],
};

export function readOpsPrefs(): OpsPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_OPS_PREFS;
    const parsed = JSON.parse(raw) as Partial<OpsPrefs>;
    return {
      myTeam: typeof parsed.myTeam === "string" ? parsed.myTeam : "",
      teamServices:
        parsed.teamServices && typeof parsed.teamServices === "object"
          ? parsed.teamServices
          : {},
      homeServiceId:
        typeof parsed.homeServiceId === "string" ? parsed.homeServiceId : "",
      homeServiceLabel:
        typeof parsed.homeServiceLabel === "string"
          ? parsed.homeServiceLabel
          : "",
      recentDeploys: Array.isArray(parsed.recentDeploys)
        ? parsed.recentDeploys.filter(
            (d): d is DeployEntry =>
              typeof d === "object" && d != null && typeof (d as DeployEntry).service === "string",
          )
        : [],
      myPolicyKeywords: Array.isArray(parsed.myPolicyKeywords)
        ? parsed.myPolicyKeywords.filter(
            (s): s is string => typeof s === "string" && s.trim().length > 0,
          )
        : [],
    };
  } catch {
    return DEFAULT_OPS_PREFS;
  }
}

/** Resolve the effective list of "my team" keywords used to classify
 *  on-call rows. Explicit `myPolicyKeywords` wins; otherwise we fall
 *  back to whitespace-splitting `myTeam` so a fresh install with just
 *  `myTeam: "Payments"` already classifies correctly. All keywords are
 *  lowercased once here so callers can do simple substring matches. */
export function resolveMyPolicyKeywords(prefs: OpsPrefs): string[] {
  const explicit = prefs.myPolicyKeywords
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 0);
  if (explicit.length > 0) return explicit;
  const fallback = prefs.myTeam
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length >= 3);
  return fallback;
}

/** Match against any keyword as a case-insensitive substring. The
 *  set of strings is policy_name + schedule_name + user_name — any
 *  hit on any field qualifies the row as "mine". */
export function isMineByKeywords(
  haystacks: (string | null | undefined)[],
  keywords: string[],
): boolean {
  if (keywords.length === 0) return false;
  const text = haystacks
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .map((s) => s.toLowerCase())
    .join(" • ");
  return keywords.some((k) => text.includes(k));
}

export function writeOpsPrefs(next: OpsPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent(OPS_PREFS_CHANGED));
  } catch {
    /* localStorage may be denied */
  }
}

export const OPS_PREFS_CHANGED = "cos:ops-prefs-changed";

/** YAML-ish text → teamServices map. Each non-empty line is
 *  `team: service1, service2`. Whitespace-tolerant. Used by the
 *  Settings textarea (CP21) and exposed for tests. */
export function parseTeamServices(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const team = line.slice(0, idx).trim();
    const services = line
      .slice(idx + 1)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (team) out[team] = services;
  }
  return out;
}

export function formatTeamServices(
  map: Record<string, string[]>,
): string {
  return Object.entries(map)
    .map(([team, services]) => `${team}: ${services.join(", ")}`)
    .join("\n");
}
