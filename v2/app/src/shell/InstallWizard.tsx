import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { showToast } from "../state/toasts";

/**
 * First-run modal. Shown once per machine when at least one
 * readiness check fails AND the user hasn't dismissed the wizard
 * before. Stores its "completed" flag in localStorage.
 *
 * Steps:
 *   1. Data folder — show the active path (auto-resolved at startup
 *      to ~/Documents/Chief of Staff/data/files for packaged builds,
 *      or the repo's data/files in dev). User can pick a different
 *      folder via the native picker; the choice is persisted via
 *      content_root_set and takes effect on next launch.
 *   2. Claude CLI — input field for binary path with auto-detect
 *      hint; saves via claude_config_set.
 *   3. Calendar — radio for transport (eventkit/ics) + optional
 *      ICS URL input; saves via calendar_config_set.
 *   4. Recovery (M8b) — generates a 24-word BIP-39 phrase, displays
 *      it once, requires re-typing four challenge words to confirm
 *      capture. Skippable only if a phrase was already confirmed
 *      previously (the user is re-running the wizard).
 *
 * "Skip" closes the wizard without writing anything; user can
 * always re-trigger via Settings → Diagnostics. The recovery step
 * does not allow Skip the first time through — losing this phrase
 * means losing the encrypted DB if Keychain ever wipes.
 */

const FIRST_RUN_KEY = "cos.first-run-complete.v1";

type Check = {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  fix_hint: string;
};
type InstallStatus = { checks: Check[]; all_ok: boolean };
type ClaudeCliConfig = {
  binary_path: string;
  settings_path: string;
  extra_args: string[];
};
type ClaudeCliStatus = {
  binary_path_configured: string;
  binary_path_resolved: string | null;
  settings_path: string;
  extra_args: string[];
  default_extra_args: string[];
  available: boolean;
  config_file: string;
};
type CalendarConfig = {
  ics_url: string;
  transport: "ics" | "eventkit";
};
type RecoveryStatus = { wrapped_present: boolean; confirmed: boolean };
type ContentRootInfo = {
  current: string;
  default: string;
  has_choice: boolean;
  env_override: boolean;
};
type NamedPerson = { name: string; role: string };
type UserProfile = {
  name: string;
  email: string;
  role: string;
  team: string;
  manager: NamedPerson | null;
  direct_reports: NamedPerson[];
};
type GitconfigDefaults = { name: string; email: string };

const EMPTY_PROFILE: UserProfile = {
  name: "",
  email: "",
  role: "",
  team: "",
  manager: null,
  direct_reports: [],
};

export function shouldShowFirstRun(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(FIRST_RUN_KEY) !== "true";
}

export function markFirstRunComplete(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(FIRST_RUN_KEY, "true");
  } catch {
    // Quota / private mode — best effort.
  }
}

/**
 * Pick four distinct word positions (1-indexed) to challenge the user
 * with. Deterministic per `seed` so the same seed yields the same
 * challenge — we use this to keep the displayed prompt stable as
 * React re-renders during typing. `seed` is generated once per
 * recovery-step mount via Math.random().
 *
 * Avoids position 1 and 24 (people tend to remember endpoints
 * better than middle words; we want to validate the whole phrase).
 */
export function pickChallengePositions(seed: number): number[] {
  // Tiny xorshift for deterministic shuffle. Doesn't need to be
  // cryptographically strong — the secret is the phrase, not the
  // challenge positions.
  let s = (seed >>> 0) || 1;
  const next = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0xffffffff;
  };
  // Inner positions: 2..23 (1-indexed).
  const pool: number[] = [];
  for (let i = 2; i <= 23; i++) pool.push(i);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, 4).sort((a, b) => a - b);
}

type Step =
  | "welcome"
  | "identity"
  | "data"
  | "claude"
  | "calendar"
  | "recovery"
  | "first-person"
  | "bootstrap"
  | "first-prep"
  | "first-brief"
  | "done";

export function InstallWizard({ onDismiss }: { onDismiss: () => void }) {
  const [status, setStatus] = useState<InstallStatus | null>(null);
  const [step, setStep] = useState<Step>("welcome");
  const [claudePath, setClaudePath] = useState("");
  const [transport, setTransport] = useState<"ics" | "eventkit">("eventkit");
  const [icsUrl, setIcsUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [rootInfo, setRootInfo] = useState<ContentRootInfo | null>(null);
  const [rootError, setRootError] = useState<string | null>(null);
  const [profile, setProfile] = useState<UserProfile>(EMPTY_PROFILE);
  const [profileLoaded, setProfileLoaded] = useState(false);
  // Claude probe state — captures the result of a "test connection"
  // round-trip so the wizard can show success/failure inline before
  // letting the user move on.
  const [claudeProbe, setClaudeProbe] = useState<
    { kind: "idle" }
    | { kind: "running" }
    | { kind: "ok"; message: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  // Calendar preview state — lets the wizard render the user's
  // actual next-few-hours of events inline so the connection
  // feels real (Phase 0.5.4).
  type CalendarEvt = {
    uid: string;
    summary: string;
    start: string;
    end: string;
    all_day: boolean;
    location: string | null;
  };
  const [calPreview, setCalPreview] = useState<
    { kind: "idle" }
    | { kind: "running" }
    | { kind: "ok"; events: CalendarEvt[] }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  // First-person scaffolding state (Phase 0.5.5). Each row is
  // user-toggleable; the "scaffold" button hits the
  // profile_scaffold_people IPC for the rows still checked.
  type ScaffoldRow = {
    name: string;
    role: string;
    relationship:
      | "direct-reports"
      | "manager"
      | "peers"
      | "skip-level"
      | "skip-level-reports"
      | "xfn";
    enabled: boolean;
  };
  const [scaffoldRows, setScaffoldRows] = useState<ScaffoldRow[]>([]);
  const [scaffoldResult, setScaffoldResult] = useState<
    | { kind: "idle" }
    | { kind: "running" }
    | { kind: "ok"; created: string[]; skipped: string[] }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  // PRD-103 §0.5/#5 bootstrap — opt-in pre-loaders that fill in
  // the user's data tree before they land in the empty app. Each
  // option maps to a wired backend IPC.
  type BootstrapOptId =
    | "org-generate"
    | "people-refresh"
    | "jira-pull"
    | "starter-projects"
    | "reminders-cron"
    | "morning-briefing-cron"
    | "weekly-review-cron";
  type BootstrapStatus =
    | { kind: "pending" }
    | { kind: "running" }
    | { kind: "ok"; summary: string }
    | { kind: "skipped" }
    | { kind: "error"; message: string };
  const [bootstrapChecked, setBootstrapChecked] = useState<
    Record<BootstrapOptId, boolean>
  >({
    "org-generate": true,
    "people-refresh": true,
    "jira-pull": false,
    "starter-projects": true,
    "reminders-cron": true,
    "morning-briefing-cron": true,
    "weekly-review-cron": true,
  });
  const [bootstrapStatus, setBootstrapStatus] = useState<
    Record<BootstrapOptId, BootstrapStatus>
  >({
    "org-generate": { kind: "pending" },
    "people-refresh": { kind: "pending" },
    "jira-pull": { kind: "pending" },
    "starter-projects": { kind: "pending" },
    "reminders-cron": { kind: "pending" },
    "morning-briefing-cron": { kind: "pending" },
    "weekly-review-cron": { kind: "pending" },
  });
  // Which starter-project templates the user wants. Pre-checked
  // ones are the ones a typical EM benefits from; the user can
  // tweak before "run selected."
  type StarterProjectKind =
    | "career-development"
    | "hiring-pipeline"
    | "mentorship"
    | "presentation-prep"
    | "quarterly-planning"
    | "new-team-member";
  const [starterProjects, setStarterProjects] = useState<
    Record<StarterProjectKind, boolean>
  >({
    "career-development": true,
    "hiring-pipeline": false,
    "mentorship": false,
    "presentation-prep": false,
    "quarterly-planning": true,
    "new-team-member": false,
  });
  const [bootstrapRunning, setBootstrapRunning] = useState(false);

  // Recovery step state. Phrase is held only in React memory and
  // never persisted; it's dropped when the wizard advances past
  // "recovery". `recoveryAlreadyConfirmed` lets us skip the step on
  // re-runs of the wizard.
  const [phrase, setPhrase] = useState<string | null>(null);
  const [phrasePhase, setPhrasePhase] = useState<"display" | "confirm">(
    "display",
  );
  const [recoveryAlreadyConfirmed, setRecoveryAlreadyConfirmed] =
    useState(false);
  const [challengeSeed, setChallengeSeed] = useState(0);
  const [challengeAnswers, setChallengeAnswers] = useState<
    Record<number, string>
  >({});
  const [challengeError, setChallengeError] = useState<string | null>(null);

  // Initial readiness probe + form prefill from current configs.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await invoke<InstallStatus>("install_status");
        if (cancelled) return;
        setStatus(s);
        const cfg = await invoke<ClaudeCliConfig>("claude_config_get");
        if (cancelled) return;
        // Pre-fill the input: prefer the user-configured path if set,
        // otherwise the path resolve_binary auto-detected on PATH or
        // in known install locations. The user can still edit it.
        if (cfg.binary_path.trim().length > 0) {
          setClaudePath(cfg.binary_path);
        } else {
          try {
            const cs = await invoke<ClaudeCliStatus>("claude_status");
            if (!cancelled && cs.binary_path_resolved) {
              setClaudePath(cs.binary_path_resolved);
            }
          } catch {
            // Auto-detect probe failed; leave blank.
          }
        }
        const cal = await invoke<CalendarConfig>("calendar_config_get");
        if (cancelled) return;
        setIcsUrl(cal.ics_url ?? "");
        setTransport(cal.transport === "ics" ? "ics" : "eventkit");
        const recovery = await invoke<RecoveryStatus>("recovery_status");
        if (cancelled) return;
        setRecoveryAlreadyConfirmed(recovery.confirmed);
        const root = await invoke<ContentRootInfo>("content_root_info");
        if (cancelled) return;
        setRootInfo(root);
        // Profile (PRD-103 / Phase 0.5.2). Read whatever's on disk;
        // if empty, fall back to ~/.gitconfig user.name + user.email
        // so the form lands pre-filled and the user just confirms.
        const onDisk = await invoke<UserProfile>("profile_get");
        if (cancelled) return;
        if (onDisk.name || onDisk.email || onDisk.role) {
          setProfile(onDisk);
        } else {
          try {
            const gc = await invoke<GitconfigDefaults>(
              "profile_gitconfig_defaults",
            );
            if (!cancelled) {
              setProfile((prev) => ({
                ...prev,
                name: gc.name,
                email: gc.email,
              }));
            }
          } catch {
            // ~/.gitconfig parse failed; leave fields blank.
          }
        }
        setProfileLoaded(true);
        // Skip past steps that are already OK so the user doesn't
        // re-enter what's already configured. Data folder is always
        // shown the first time (the user should know where it is)
        // unless we're re-entering the wizard after everything else
        // is fine, in which case we land on whatever is broken.
        const claudeOk = s.checks.find((c) => c.id === "claude-cli")?.ok;
        const calOk = s.checks.find((c) => c.id === "calendar-source")?.ok;
        const isReentry =
          window.localStorage.getItem(FIRST_RUN_KEY) === "true";
        if (claudeOk && calOk && recovery.confirmed) setStep("done");
        else if (isReentry && claudeOk && calOk) setStep("recovery");
        else if (isReentry && claudeOk) setStep("calendar");
        else if (isReentry) setStep("claude");
        // First-time visitors land on Welcome; the magical-onboarding
        // flow walks them through the value before the plumbing.
        // Re-entries (recovery from a misconfig) skip Welcome since
        // the user has seen it before.
        else setStep("welcome");
      } catch (error) {
        showToast({
          kind: "error",
          text: `Setup status check failed: ${String(error)}`,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const finish = (mode: "done" | "skip") => {
    markFirstRunComplete();
    onDismiss();
    if (mode === "done") {
      showToast({
        kind: "success",
        text: "Setup complete. You're good to go.",
        durationMs: 3500,
      });
    }
  };

  const probeClaude = async () => {
    setClaudeProbe({ kind: "running" });
    try {
      const reply = await invoke<string>("claude_ping");
      setClaudeProbe({ kind: "ok", message: reply });
    } catch (error) {
      setClaudeProbe({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // Re-fetch install_status when entering the outro so the recap
  // reflects what the user just configured. Without this the outro
  // would show stale "not configured" entries for Claude / calendar
  // after the user successfully wired them mid-wizard.
  useEffect(() => {
    if (step !== "done") return;
    let cancelled = false;
    (async () => {
      try {
        const fresh = await invoke<InstallStatus>("install_status");
        if (!cancelled) setStatus(fresh);
      } catch {
        // Stale status is fine — the recap just shows whatever was
        // there when the wizard mounted.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step]);

  // When the user reaches the first-person step, pre-populate the
  // scaffold rows from the profile they entered earlier (manager +
  // direct reports). Only re-runs when the step changes so editing
  // the rows isn't reset by an unrelated render.
  useEffect(() => {
    if (step !== "first-person") return;
    if (scaffoldRows.length > 0) return; // already populated
    const rows: ScaffoldRow[] = [];
    if (profile.manager?.name?.trim()) {
      rows.push({
        name: profile.manager.name,
        role: profile.manager.role ?? "",
        relationship: "manager",
        enabled: true,
      });
    }
    for (const dr of profile.direct_reports) {
      if (dr.name.trim().length === 0) continue;
      rows.push({
        name: dr.name,
        role: dr.role ?? "",
        relationship: "direct-reports",
        enabled: true,
      });
    }
    setScaffoldRows(rows);
  }, [step, profile, scaffoldRows.length]);

  const runScaffold = async () => {
    setScaffoldResult({ kind: "running" });
    try {
      const enabled = scaffoldRows.filter((r) => r.enabled);
      if (enabled.length === 0) {
        // Skip the IPC entirely when nothing's selected — empties
        // count as "user explicitly chose to skip."
        setScaffoldResult({ kind: "ok", created: [], skipped: [] });
        return;
      }
      const result = await invoke<{
        created: string[];
        skipped: string[];
      }>("profile_scaffold_people", {
        people: enabled.map((r) => ({
          name: r.name,
          role: r.role,
          relationship: r.relationship,
        })),
      });
      setScaffoldResult({
        kind: "ok",
        created: result.created,
        skipped: result.skipped,
      });
    } catch (error) {
      setScaffoldResult({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const runBootstrap = async () => {
    setBootstrapRunning(true);
    const setStatus = (id: BootstrapOptId, s: BootstrapStatus) =>
      setBootstrapStatus((prev) => ({ ...prev, [id]: s }));
    const errorMsg = (e: unknown) =>
      e instanceof Error ? e.message : String(e);
    try {
      // 1. org-generate — pulls Slack profiles + your team
      //    structure into areas/org/org.json.
      if (bootstrapChecked["org-generate"]) {
        setStatus("org-generate", { kind: "running" });
        try {
          const result = await invoke<{ people?: unknown[] }>(
            "org_generate",
          );
          const count = Array.isArray(result.people)
            ? result.people.length
            : 0;
          setStatus("org-generate", {
            kind: "ok",
            summary: `${count} people indexed`,
          });
        } catch (error) {
          setStatus("org-generate", {
            kind: "error",
            message: errorMsg(error),
          });
        }
      } else {
        setStatus("org-generate", { kind: "skipped" });
      }

      // 2. people-refresh — iterate over manager + direct reports
      //    captured in identity step. Each call hits the
      //    person-refresh skill which writes person.json with bio,
      //    Slack handle, photo URL, etc.
      if (bootstrapChecked["people-refresh"]) {
        const targets: Array<{ slug: string; rel_path: string }> = [];
        if (profile.manager?.name?.trim()) {
          const slug = slugifyClient(profile.manager.name);
          if (slug) {
            targets.push({
              slug,
              rel_path: `areas/one-on-ones/manager/${slug}`,
            });
          }
        }
        for (const dr of profile.direct_reports) {
          const slug = slugifyClient(dr.name);
          if (slug) {
            targets.push({
              slug,
              rel_path: `areas/one-on-ones/direct-reports/${slug}`,
            });
          }
        }
        if (targets.length === 0) {
          setStatus("people-refresh", { kind: "skipped" });
        } else {
          setStatus("people-refresh", { kind: "running" });
          let ok = 0;
          let failed = 0;
          for (const t of targets) {
            try {
              await invoke("person_refresh", t);
              ok++;
            } catch {
              failed++;
            }
          }
          if (failed === 0) {
            setStatus("people-refresh", {
              kind: "ok",
              summary: `${ok} profile${ok === 1 ? "" : "s"} refreshed`,
            });
          } else {
            setStatus("people-refresh", {
              kind: "error",
              message: `${ok} succeeded · ${failed} failed`,
            });
          }
        }
      } else {
        setStatus("people-refresh", { kind: "skipped" });
      }

      // 3. ops-my-jira — pulls user's open tickets so the Tasks +
      //    Ops surfaces have real signal on day one.
      if (bootstrapChecked["jira-pull"]) {
        setStatus("jira-pull", { kind: "running" });
        try {
          const result = await invoke<{ issues?: unknown[] }>("jira_my_run");
          const count = Array.isArray(result?.issues)
            ? result.issues.length
            : 0;
          setStatus("jira-pull", {
            kind: "ok",
            summary: `${count} issue${count === 1 ? "" : "s"} indexed`,
          });
        } catch (error) {
          setStatus("jira-pull", {
            kind: "error",
            message: errorMsg(error),
          });
        }
      } else {
        setStatus("jira-pull", { kind: "skipped" });
      }

      // 4. starter-projects — drop README templates for the kinds
      //    the user picked. Pure filesystem write; no Claude call.
      if (bootstrapChecked["starter-projects"]) {
        const kinds = (
          Object.entries(starterProjects) as [StarterProjectKind, boolean][]
        )
          .filter(([, on]) => on)
          .map(([k]) => k);
        if (kinds.length === 0) {
          setStatus("starter-projects", { kind: "skipped" });
        } else {
          setStatus("starter-projects", { kind: "running" });
          try {
            const created = await invoke<string[]>(
              "profile_scaffold_starter_projects",
              { kinds },
            );
            setStatus("starter-projects", {
              kind: "ok",
              summary:
                created.length === 0
                  ? "all selected projects already exist"
                  : `${created.length} project folder${created.length === 1 ? "" : "s"} created`,
            });
          } catch (error) {
            setStatus("starter-projects", {
              kind: "error",
              message: errorMsg(error),
            });
          }
        }
      } else {
        setStatus("starter-projects", { kind: "skipped" });
      }

      // 5. reminders-cron — install the launchctl agent that pings
      //    overdue tasks to Apple Reminders every morning at 8am.
      if (bootstrapChecked["reminders-cron"]) {
        setStatus("reminders-cron", { kind: "running" });
        try {
          const result = await invoke<{
            status: string;
            stdout: string;
            stderr: string;
          }>("automation_cron_run", {
            kind: "reminders-overdue",
            action: "install",
          });
          if (result.status === "ok") {
            setStatus("reminders-cron", {
              kind: "ok",
              summary: "daily 8am notifier installed",
            });
          } else {
            setStatus("reminders-cron", {
              kind: "error",
              message: result.stderr.trim() || "install script returned non-zero",
            });
          }
        } catch (error) {
          setStatus("reminders-cron", {
            kind: "error",
            message: errorMsg(error),
          });
        }
      } else {
        setStatus("reminders-cron", { kind: "skipped" });
      }

      // 6. morning-briefing-cron — install the daily 7am
      //    launchctl agent that runs /morning-briefing automatically.
      if (bootstrapChecked["morning-briefing-cron"]) {
        setStatus("morning-briefing-cron", { kind: "running" });
        try {
          const result = await invoke<{
            status: string;
            stdout: string;
            stderr: string;
          }>("automation_cron_run", {
            kind: "morning-briefing",
            action: "install",
          });
          if (result.status === "ok") {
            setStatus("morning-briefing-cron", {
              kind: "ok",
              summary: "weekday 7am briefing installed",
            });
          } else {
            setStatus("morning-briefing-cron", {
              kind: "error",
              message: result.stderr.trim() || "install script returned non-zero",
            });
          }
        } catch (error) {
          setStatus("morning-briefing-cron", {
            kind: "error",
            message: errorMsg(error),
          });
        }
      } else {
        setStatus("morning-briefing-cron", { kind: "skipped" });
      }

      // 7. weekly-review-cron — install the Friday 8pm launchctl
      //    agent that runs /weekly-review automatically.
      if (bootstrapChecked["weekly-review-cron"]) {
        setStatus("weekly-review-cron", { kind: "running" });
        try {
          const result = await invoke<{
            status: string;
            stdout: string;
            stderr: string;
          }>("automation_cron_run", {
            kind: "weekly-review",
            action: "install",
          });
          if (result.status === "ok") {
            setStatus("weekly-review-cron", {
              kind: "ok",
              summary: "Friday 8pm review installed",
            });
          } else {
            setStatus("weekly-review-cron", {
              kind: "error",
              message: result.stderr.trim() || "install script returned non-zero",
            });
          }
        } catch (error) {
          setStatus("weekly-review-cron", {
            kind: "error",
            message: errorMsg(error),
          });
        }
      } else {
        setStatus("weekly-review-cron", { kind: "skipped" });
      }
    } finally {
      setBootstrapRunning(false);
    }
  };

  /** Frontend mirror of profile.rs::slugify. Used by the people-
   *  refresh bootstrap step to derive the slug + rel_path for each
   *  person in the profile so the IPC has the right paths. */
  function slugifyClient(name: string): string {
    let out = "";
    let prevDash = true;
    for (const ch of name) {
      if (/[a-zA-Z0-9]/.test(ch)) {
        out += ch.toLowerCase();
        prevDash = false;
      } else if (!prevDash) {
        out += "-";
        prevDash = true;
      }
    }
    while (out.endsWith("-")) out = out.slice(0, -1);
    return out;
  }

  const previewCalendar = async () => {
    setCalPreview({ kind: "running" });
    try {
      // Save the chosen transport first so calendar_events sees it.
      await invoke("calendar_config_set", {
        config: { ics_url: icsUrl.trim(), transport },
      });
      // The EventKit adapter expects YYYY-MM-DD whole-day windows
      // — passing a full RFC-3339 timestamp errors out with
      // "invalid --from". Pull today + tomorrow so we cover the
      // next 24h regardless of when the user lands on this step.
      const now = new Date();
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const isoDay = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      // Frontend timeout — EventKit's permission prompt can hang
      // indefinitely if the user ignores it. 30 seconds is far more
      // than a normal calendar fetch needs; if we hit it, the user
      // probably dismissed or didn't see the OS dialog.
      const events = await Promise.race([
        invoke<CalendarEvt[]>("calendar_events", {
          from: isoDay(now),
          to: isoDay(tomorrow),
        }),
        new Promise<never>((_, reject) =>
          window.setTimeout(
            () =>
              reject(
                new Error(
                  "Calendar fetch timed out — if you saw a permission prompt, accept it and try again",
                ),
              ),
            30_000,
          ),
        ),
      ]);
      setCalPreview({ kind: "ok", events });
    } catch (error) {
      setCalPreview({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const saveProfile = async () => {
    setBusy(true);
    try {
      await invoke("profile_set", { profile });
      setStep("data");
    } catch (error) {
      // Stay on the step so the user can fix whatever went wrong
      // (typically: a content root that became unwritable between
      // wizard sessions, or a content root that was renamed). The
      // toast surfaces the cause.
      showToast({
        kind: "error",
        text: `Couldn't save profile: ${error instanceof Error ? error.message : String(error)}`,
        durationMs: 6000,
      });
    } finally {
      setBusy(false);
    }
  };

  const pickDataFolder = async () => {
    setRootError(null);
    setBusy(true);
    try {
      // Lazy-import the dialog plugin so first-paint of the wizard
      // doesn't block on it.
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        directory: true,
        multiple: false,
        title: "Choose your Chief of Staff data folder",
        defaultPath: rootInfo?.current,
      });
      if (typeof picked !== "string") {
        setBusy(false);
        return;
      }
      const canonical = await invoke<string>("content_root_set", {
        root: picked,
      });
      setRootInfo((prev) =>
        prev ? { ...prev, current: canonical, has_choice: true } : prev,
      );
    } catch (error) {
      setRootError(`Couldn't save folder choice: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const saveClaude = async () => {
    setBusy(true);
    try {
      await invoke("claude_config_set", {
        config: {
          binary_path: claudePath.trim(),
          settings_path: "",
          extra_args: [
            "--print",
            "--permission-mode",
            "auto",
            "--model",
            "opus",
          ],
        },
      });
      setStep("calendar");
    } catch (error) {
      showToast({
        kind: "error",
        text: `Could not save Claude path: ${String(error)}`,
      });
    } finally {
      setBusy(false);
    }
  };

  const saveCalendar = async () => {
    setBusy(true);
    try {
      await invoke("calendar_config_set", {
        config: { ics_url: icsUrl.trim(), transport },
      });
      setStep("recovery");
    } catch (error) {
      showToast({
        kind: "error",
        text: `Could not save calendar config: ${String(error)}`,
      });
    } finally {
      setBusy(false);
    }
  };

  const generatePhrase = async () => {
    setBusy(true);
    setChallengeError(null);
    try {
      // Reset any prior phrase so a re-generation produces a fresh blob.
      const status = await invoke<RecoveryStatus>("recovery_status");
      if (status.wrapped_present) {
        await invoke("recovery_reset");
      }
      const fresh = await invoke<string>("recovery_create_phrase");
      setPhrase(fresh);
      setChallengeSeed(Math.floor(Math.random() * 0x7fffffff));
      setChallengeAnswers({});
      setPhrasePhase("display");
    } catch (error) {
      showToast({
        kind: "error",
        text: `Could not generate recovery phrase: ${String(error)}`,
      });
    } finally {
      setBusy(false);
    }
  };

  const challengePositions = useMemo(
    () => pickChallengePositions(challengeSeed),
    [challengeSeed],
  );

  const checkChallenge = async () => {
    if (!phrase) return;
    const words = phrase.trim().split(/\s+/);
    const wrong: number[] = [];
    for (const pos of challengePositions) {
      const expected = words[pos - 1]?.toLowerCase() ?? "";
      const got = (challengeAnswers[pos] ?? "").trim().toLowerCase();
      if (expected !== got) wrong.push(pos);
    }
    if (wrong.length > 0) {
      setChallengeError(
        `${wrong.length} word${wrong.length === 1 ? "" : "s"} didn't match. Double-check your written copy.`,
      );
      return;
    }
    setBusy(true);
    try {
      await invoke("recovery_mark_confirmed");
      // Drop the phrase from memory now that the user has demonstrably
      // captured it. React state going to null doesn't zeroize the
      // string, but it does drop the reference; nothing we can do about
      // V8 string interning short of a Wasm-side handler, which is
      // overkill for v2.0.
      setPhrase(null);
      setChallengeAnswers({});
      setRecoveryAlreadyConfirmed(true);
      setStep("first-person");
    } catch (error) {
      showToast({
        kind: "error",
        text: `Could not record confirmation: ${String(error)}`,
      });
    } finally {
      setBusy(false);
    }
  };

  const contentCheck = status?.checks.find((c) => c.id === "content-root");
  const claudeCheck = status?.checks.find((c) => c.id === "claude-cli");
  const calCheck = status?.checks.find((c) => c.id === "calendar-source");

  return (
    <div
      className="cos-wizard-scrim"
      role="dialog"
      aria-modal="true"
      aria-label="First-run setup"
    >
      <div className="cos-wizard">
        <header className="cos-wizard-head">
          <h1>Welcome to Chief of Staff</h1>
          <p className="cos-section-lede">
            {step === "welcome"
              ? "Your day, organized — without the busywork."
              : "Quick setup so the app's ready for daily use."}
          </p>
        </header>

        <Stepper step={step} onJump={(target) => setStep(target)} />

        {step === "welcome" && (
          <section className="cos-wizard-step cos-wizard-welcome">
            <p className="cos-wizard-hero">
              Five minutes from now, you'll be looking at <em>your</em>{" "}
              calendar, <em>your</em> 1:1s, and a draft of tomorrow morning's
              briefing — all generated from the data already on your machine.
            </p>
            <ul className="cos-wizard-bullets">
              <li>
                <strong>Tabs over your work</strong> — one for each person,
                project, or doc. Cmd+T new, Cmd+W close, Cmd+1..9 jump.
              </li>
              <li>
                <strong>Claude as your chief of staff</strong> — drafts 1:1
                prep, digests meetings, triages tasks, writes your weekly
                review. You stay in the loop; it does the legwork.
              </li>
              <li>
                <strong>Your data, on your laptop</strong> — markdown files
                + SQLite, never uploaded anywhere you didn't pick.
              </li>
            </ul>
            <p className="cos-section-lede">
              We'll walk you through the setup — about 5 minutes. You can
              skip any step and come back to it later from Settings.
            </p>
            <div className="cos-wizard-actions">
              <button
                type="button"
                className="cos-btn cos-btn-ghost"
                onClick={() => finish("skip")}
              >
                skip — I'll explore on my own
              </button>
              <button
                type="button"
                className="cos-btn cos-btn-primary"
                onClick={() => setStep("identity")}
                autoFocus
              >
                let's go →
              </button>
            </div>
          </section>
        )}

        {step === "identity" && (
          <section className="cos-wizard-step">
            <h2>About you</h2>
            <p className="cos-section-lede">
              A bit of context so the assistant frames its drafts as
              "you, an EM at your team" rather than generic "assistant
              writing on behalf of a user." Every field is optional — you
              can fill in just the parts that feel relevant.
            </p>
            {!profileLoaded ? (
              <p>Loading…</p>
            ) : (
              <div className="cos-wizard-form">
                <label className="cos-wizard-field">
                  <span className="cos-wizard-field-label">Name</span>
                  <input
                    type="text"
                    className="cos-wizard-input"
                    value={profile.name}
                    maxLength={120}
                    onChange={(e) =>
                      setProfile({ ...profile, name: e.target.value })
                    }
                    placeholder="e.g. Alice Smith"
                  />
                </label>
                <label className="cos-wizard-field">
                  <span className="cos-wizard-field-label">Email</span>
                  <input
                    type="email"
                    className="cos-wizard-input"
                    value={profile.email}
                    maxLength={254}
                    onChange={(e) =>
                      setProfile({ ...profile, email: e.target.value })
                    }
                    placeholder="alice@example.com"
                  />
                </label>
                <label className="cos-wizard-field">
                  <span className="cos-wizard-field-label">Role</span>
                  <input
                    type="text"
                    className="cos-wizard-input"
                    value={profile.role}
                    maxLength={120}
                    onChange={(e) =>
                      setProfile({ ...profile, role: e.target.value })
                    }
                    placeholder="e.g. Engineering Manager"
                  />
                </label>
                <label className="cos-wizard-field">
                  <span className="cos-wizard-field-label">Team</span>
                  <input
                    type="text"
                    className="cos-wizard-input"
                    value={profile.team}
                    maxLength={120}
                    onChange={(e) =>
                      setProfile({ ...profile, team: e.target.value })
                    }
                    placeholder="e.g. Platform Infrastructure"
                  />
                </label>
                <label className="cos-wizard-field">
                  <span className="cos-wizard-field-label">
                    Your manager
                  </span>
                  <input
                    type="text"
                    className="cos-wizard-input"
                    value={profile.manager?.name ?? ""}
                    maxLength={120}
                    onChange={(e) =>
                      setProfile({
                        ...profile,
                        manager: e.target.value.trim()
                          ? {
                              name: e.target.value,
                              role: profile.manager?.role ?? "",
                            }
                          : null,
                      })
                    }
                    placeholder="e.g. Bob Jones"
                  />
                </label>
                <label className="cos-wizard-field">
                  <span className="cos-wizard-field-label">
                    Direct reports
                  </span>
                  <input
                    type="text"
                    className="cos-wizard-input"
                    value={profile.direct_reports
                      .map((p) => p.name)
                      .join(", ")}
                    maxLength={1024}
                    onChange={(e) =>
                      setProfile({
                        ...profile,
                        direct_reports: e.target.value
                          .split(",")
                          .map((s) => s.trim())
                          .filter((s) => s.length > 0)
                          // Cap at 30 — no manager has more than that
                          // many direct reports in practice; protects
                          // against pathological paste-bombs.
                          .slice(0, 30)
                          .map((name) => ({ name, role: "" })),
                      })
                    }
                    placeholder="comma-separated names — e.g. Carla, Dan, Eve"
                  />
                  <p className="cos-helper-text">
                    Just the names — we'll create starter README folders
                    for each one in a later step (you can opt out).
                  </p>
                </label>
              </div>
            )}
            <div className="cos-wizard-actions">
              <button
                type="button"
                className="cos-btn cos-btn-ghost"
                onClick={() => setStep("welcome")}
              >
                ← back
              </button>
              <button
                type="button"
                className="cos-btn cos-btn-ghost"
                onClick={() => setStep("data")}
              >
                skip — fill in later
              </button>
              <button
                type="button"
                className="cos-btn cos-btn-primary"
                onClick={saveProfile}
                disabled={busy || !profileLoaded}
              >
                {busy ? "saving…" : "save + next"}
              </button>
            </div>
          </section>
        )}

        {step === "data" && (
          <section className="cos-wizard-step">
            <h2>Data folder</h2>
            <p className="cos-section-lede">
              This is where your notes, sessions, and the SQLite task DB
              will live. You can pick a different folder if you have an
              existing work-agent clone, or accept the default and we'll
              create a starter folder for you.
            </p>
            {rootInfo ? (
              <>
                <dl className="cos-status">
                  <dt>Active path</dt>
                  <dd>
                    <code className="cos-path">{rootInfo.current}</code>
                  </dd>
                  {rootInfo.current !== rootInfo.default && (
                    <>
                      <dt>Default</dt>
                      <dd>
                        <code className="cos-path">{rootInfo.default}</code>
                      </dd>
                    </>
                  )}
                </dl>
                {rootInfo.env_override && (
                  <p className="cos-helper-text">
                    The <code>COS_CONTENT_ROOT</code> environment variable
                    is set for this session and overrides any saved
                    choice. If that wasn't intentional, unset it and
                    relaunch.
                  </p>
                )}
                {contentCheck?.ok ? (
                  <p>
                    <span className="cos-good">✓</span> Folder ready.
                  </p>
                ) : (
                  <p className="cos-error">
                    The folder doesn't exist yet — we'll create it on the
                    next launch. If you'd rather point at an existing
                    folder, choose one below.
                  </p>
                )}
                {rootError && <p className="cos-error">{rootError}</p>}
              </>
            ) : (
              <p>Loading…</p>
            )}
            <div className="cos-wizard-actions">
              <button
                type="button"
                className="cos-btn cos-btn-ghost"
                onClick={() => setStep("identity")}
              >
                ← back
              </button>
              <button
                type="button"
                className="cos-btn"
                onClick={pickDataFolder}
                disabled={busy}
              >
                {busy ? "saving…" : "choose different folder"}
              </button>
              <button
                type="button"
                className="cos-btn cos-btn-primary"
                onClick={() => setStep("claude")}
                disabled={busy || !rootInfo}
              >
                next →
              </button>
            </div>
          </section>
        )}

        {step === "claude" && (
          <section className="cos-wizard-step">
            <h2>Connect Claude</h2>
            <p className="cos-section-lede">
              This is where the magic happens. Skills (briefing, 1:1 prep,
              meeting digest, task triage) shell out to your local{" "}
              <code>claude</code> binary, so they run with your model
              choice, your MCP servers, and your billing.
            </p>
            {claudeCheck?.ok ? (
              <p>
                <span className="cos-good">✓</span> {claudeCheck.detail}
              </p>
            ) : (
              <>
                <label
                  htmlFor="cos-wiz-claude"
                  className="cos-wizard-field-label"
                >
                  Path to <code>claude</code> binary
                </label>
                <input
                  id="cos-wiz-claude"
                  type="text"
                  className="cos-wizard-input"
                  value={claudePath}
                  onChange={(e) => setClaudePath(e.target.value)}
                  placeholder="/Users/you/.claude/local/claude"
                />
                <p className="cos-helper-text">
                  {claudePath
                    ? "Auto-detected — confirm or edit and save."
                    : (
                      <>
                        Common locations:{" "}
                        <code>~/.claude/local/claude</code>,{" "}
                        <code>/opt/homebrew/bin/claude</code>,{" "}
                        <code>/usr/local/bin/claude</code>. Run{" "}
                        <code>which claude</code> in a terminal if unsure.
                      </>
                    )}
                </p>
              </>
            )}
            {/* PRD-103 / Phase 0.5.3 — live probe so the user sees
                Claude actually responding before moving on. */}
            <div className="cos-wizard-probe">
              <button
                type="button"
                className="cos-btn"
                onClick={probeClaude}
                disabled={
                  claudeProbe.kind === "running" ||
                  (!claudeCheck?.ok && !claudePath.trim())
                }
              >
                {claudeProbe.kind === "running"
                  ? "testing…"
                  : "test the connection"}
              </button>
              {claudeProbe.kind === "running" && (
                <p className="cos-helper-text cos-wizard-probe-result">
                  <span className="cos-wizard-probe-spinner" aria-hidden />
                  Sending a tiny prompt and waiting for a reply — usually
                  takes 5–10 seconds, sometimes a bit longer on the first
                  call as the CLI warms up.
                </p>
              )}
              {claudeProbe.kind === "ok" && (
                <p className="cos-good cos-wizard-probe-result">
                  ✓ Claude responded. {claudeProbe.message}
                </p>
              )}
              {claudeProbe.kind === "error" && (
                <p className="cos-error cos-wizard-probe-result">
                  ✗ {claudeProbe.message}
                </p>
              )}
              {claudeProbe.kind === "idle" && claudeCheck?.ok && (
                <p className="cos-helper-text">
                  Optional — fires a tiny prompt and shows the response so
                  you know it's wired before moving on.
                </p>
              )}
            </div>
            <div className="cos-wizard-actions">
              <button
                type="button"
                className="cos-btn cos-btn-ghost"
                onClick={() => setStep("data")}
              >
                ← back
              </button>
              <button
                type="button"
                className="cos-btn cos-btn-ghost"
                onClick={() => setStep("calendar")}
              >
                skip this step
              </button>
              <button
                type="button"
                className="cos-btn cos-btn-primary"
                onClick={claudeCheck?.ok ? () => setStep("calendar") : saveClaude}
                disabled={busy || (!claudeCheck?.ok && !claudePath.trim())}
              >
                {busy ? "saving…" : claudeCheck?.ok ? "next →" : "save + next"}
              </button>
            </div>
          </section>
        )}

        {step === "calendar" && (
          <section className="cos-wizard-step">
            <h2>Connect your calendar</h2>
            <p className="cos-section-lede">
              Today's meetings show up on Home, in 1:1 prep, and in
              morning briefings. Pick how the app should reach your
              calendar — macOS Calendar.app is the easiest because it
              already knows about every account you've signed in to.
            </p>
            <fieldset className="cos-calendar-transport">
              <legend>Source</legend>
              <label>
                <input
                  type="radio"
                  checked={transport === "eventkit"}
                  onChange={() => setTransport("eventkit")}
                />
                <span>
                  <strong>macOS Calendar (recommended)</strong> — reads from
                  Calendar.app, prompts for permission on first refresh.
                </span>
              </label>
              <label>
                <input
                  type="radio"
                  checked={transport === "ics"}
                  onChange={() => setTransport("ics")}
                />
                <span>ICS subscription URL</span>
              </label>
            </fieldset>
            {transport === "ics" || icsUrl ? (
              <>
                <label htmlFor="cos-wiz-ics">
                  ICS URL{transport === "eventkit" ? " (fallback)" : ""}
                </label>
                <input
                  id="cos-wiz-ics"
                  type="url"
                  className="cos-wizard-input"
                  value={icsUrl}
                  onChange={(e) => setIcsUrl(e.target.value)}
                  placeholder="https://calendar.google.com/.../basic.ics"
                />
              </>
            ) : null}
            <p className="cos-helper-text">
              You can change this anytime in Settings → Calendar.
            </p>
            {/* PRD-103 / Phase 0.5.4 — live preview so the user
                sees the connection works before moving on. EventKit
                triggers macOS's permission prompt the first time. */}
            <div className="cos-wizard-probe">
              <button
                type="button"
                className="cos-btn"
                onClick={previewCalendar}
                disabled={
                  calPreview.kind === "running" ||
                  (transport === "ics" && !icsUrl.trim())
                }
              >
                {calPreview.kind === "running"
                  ? "fetching…"
                  : "preview today's events"}
              </button>
              {calPreview.kind === "ok" && calPreview.events.length === 0 && (
                <p className="cos-helper-text cos-wizard-probe-result">
                  Connected — your calendar is empty for the next 12 hours.
                </p>
              )}
              {calPreview.kind === "ok" && calPreview.events.length > 0 && (
                <>
                  <p className="cos-good cos-wizard-probe-result">
                    ✓ Connected — next {calPreview.events.length} event
                    {calPreview.events.length === 1 ? "" : "s"}:
                  </p>
                  <ul className="cos-wizard-events">
                    {calPreview.events.slice(0, 5).map((ev) => (
                      <li key={ev.uid}>
                        <span className="cos-wizard-event-time">
                          {ev.all_day
                            ? "all-day"
                            : formatEventTime(ev.start)}
                        </span>
                        <span className="cos-wizard-event-summary">
                          {ev.summary || "(no title)"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {calPreview.kind === "error" && (
                <p className="cos-error cos-wizard-probe-result">
                  ✗ {calPreview.message}
                </p>
              )}
              {calPreview.kind === "idle" && (
                <p className="cos-helper-text">
                  Optional — fires a real fetch (and triggers the macOS
                  permission prompt for EventKit) so you know the
                  connection works.
                </p>
              )}
            </div>
            <div className="cos-wizard-actions">
              <button
                type="button"
                className="cos-btn cos-btn-ghost"
                onClick={() => setStep("claude")}
              >
                ← back
              </button>
              <button
                type="button"
                className="cos-btn cos-btn-primary"
                onClick={saveCalendar}
                disabled={busy || (transport === "ics" && !icsUrl.trim())}
              >
                {busy ? "saving…" : "save + next"}
              </button>
            </div>
          </section>
        )}

        {step === "recovery" && (
          <section className="cos-wizard-step">
            <h2>Recovery phrase</h2>
            {recoveryAlreadyConfirmed && phrasePhase === "display" && !phrase ? (
              <>
                <p>
                  <span className="cos-good">✓</span> A recovery phrase is
                  already set up. Re-generate only if you've lost the original
                  written copy.
                </p>
                <div className="cos-wizard-actions">
                  <button
                    type="button"
                    className="cos-btn cos-btn-ghost"
                    onClick={() => setStep("calendar")}
                  >
                    back
                  </button>
                  <button
                    type="button"
                    className="cos-btn cos-btn-ghost"
                    onClick={generatePhrase}
                    disabled={busy}
                  >
                    {busy ? "regenerating…" : "regenerate phrase"}
                  </button>
                  <button
                    type="button"
                    className="cos-btn"
                    onClick={() => setStep("first-person")}
                  >
                    keep existing → next
                  </button>
                </div>
              </>
            ) : !phrase ? (
              <>
                <p className="cos-section-lede">
                  Your data is encrypted with a key in the macOS Keychain. If
                  the Keychain is ever wiped (Time Machine restore, transfer
                  to a new Mac via SetupAssistant), this <strong>24-word
                  phrase</strong> is the only way to recover access.
                </p>
                <p className="cos-helper-text">
                  We'll show it on the next screen. Have pen + paper ready —
                  the phrase is shown once and never stored where you could
                  read it back.
                </p>
                <div className="cos-wizard-actions">
                  <button
                    type="button"
                    className="cos-btn cos-btn-ghost"
                    onClick={() => setStep("calendar")}
                  >
                    back
                  </button>
                  <button
                    type="button"
                    className="cos-btn"
                    onClick={generatePhrase}
                    disabled={busy}
                  >
                    {busy ? "generating…" : "generate phrase"}
                  </button>
                </div>
              </>
            ) : phrasePhase === "display" ? (
              <>
                <p className="cos-section-lede">
                  Write down all 24 words in order. Don't screenshot, paste
                  into a chat, or sync to a cloud notes app — the phrase
                  unlocks every encrypted file you've ever written.
                </p>
                <ol className="cos-recovery-words" aria-label="Recovery phrase">
                  {phrase.split(/\s+/).map((w, i) => (
                    <li key={i}>
                      <span className="cos-recovery-num">{i + 1}.</span>
                      <span className="cos-recovery-word">{w}</span>
                    </li>
                  ))}
                </ol>
                <div className="cos-wizard-actions">
                  <button
                    type="button"
                    className="cos-btn cos-btn-ghost"
                    onClick={generatePhrase}
                    disabled={busy}
                  >
                    regenerate
                  </button>
                  <button
                    type="button"
                    className="cos-btn"
                    onClick={() => setPhrasePhase("confirm")}
                  >
                    I've written it down → confirm
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="cos-section-lede">
                  Type the words at these positions to confirm you've
                  captured the phrase correctly.
                </p>
                <div className="cos-recovery-challenge">
                  {challengePositions.map((pos) => (
                    <label key={pos}>
                      <span className="cos-recovery-num">word {pos}</span>
                      <input
                        type="text"
                        className="cos-wizard-input"
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        value={challengeAnswers[pos] ?? ""}
                        onChange={(e) =>
                          setChallengeAnswers((prev) => ({
                            ...prev,
                            [pos]: e.target.value,
                          }))
                        }
                      />
                    </label>
                  ))}
                </div>
                {challengeError && (
                  <p className="cos-error">{challengeError}</p>
                )}
                <div className="cos-wizard-actions">
                  <button
                    type="button"
                    className="cos-btn cos-btn-ghost"
                    onClick={() => {
                      setPhrasePhase("display");
                      setChallengeError(null);
                    }}
                  >
                    back to phrase
                  </button>
                  <button
                    type="button"
                    className="cos-btn"
                    onClick={checkChallenge}
                    disabled={
                      busy ||
                      challengePositions.some(
                        (p) => !(challengeAnswers[p]?.trim() ?? ""),
                      )
                    }
                  >
                    {busy ? "checking…" : "confirm"}
                  </button>
                </div>
              </>
            )}
          </section>
        )}

        {step === "first-person" && (
          <section className="cos-wizard-step">
            <h2>Set up your 1:1s</h2>
            <p className="cos-section-lede">
              We picked up your manager and direct reports from the
              "About you" step. We'll create a starter folder for each
              one — just a README scaffold and an empty{" "}
              <code>sessions/</code> directory ready for your next 1:1.
            </p>
            {scaffoldRows.length === 0 && scaffoldResult.kind === "idle" ? (
              <p className="cos-helper-text">
                You skipped or didn't fill in people earlier. That's
                fine — you can set up 1:1s anytime by creating a folder
                under{" "}
                <code>areas/one-on-ones/&lt;relationship&gt;/&lt;name&gt;/</code>{" "}
                or by re-running this wizard from Settings → Diagnostics.
              </p>
            ) : (
              <ul className="cos-wizard-people">
                {scaffoldRows.map((row, i) => (
                  <li key={`${row.relationship}-${row.name}-${i}`}>
                    <label>
                      <input
                        type="checkbox"
                        checked={row.enabled}
                        onChange={(e) =>
                          setScaffoldRows((prev) =>
                            prev.map((r, j) =>
                              j === i
                                ? { ...r, enabled: e.target.checked }
                                : r,
                            ),
                          )
                        }
                      />
                      <span>
                        <strong>{row.name}</strong>
                        {row.role ? (
                          <span className="cos-content-muted">
                            {" — "}
                            {row.role}
                          </span>
                        ) : null}
                        <span className="cos-wizard-people-rel">
                          {" "}
                          ({row.relationship})
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {scaffoldResult.kind === "ok" && (
              <p className="cos-good cos-wizard-probe-result">
                ✓{" "}
                {scaffoldResult.created.length > 0
                  ? `Created ${scaffoldResult.created.length} folder${scaffoldResult.created.length === 1 ? "" : "s"}: ${scaffoldResult.created.join(", ")}.`
                  : "Skipped — nothing scaffolded."}
                {scaffoldResult.skipped.length > 0 && (
                  <>
                    {" "}
                    Existing folders left as-is:{" "}
                    {scaffoldResult.skipped.join(", ")}.
                  </>
                )}
              </p>
            )}
            {scaffoldResult.kind === "error" && (
              <p className="cos-error cos-wizard-probe-result">
                ✗ {scaffoldResult.message}
              </p>
            )}
            <div className="cos-wizard-actions">
              <button
                type="button"
                className="cos-btn cos-btn-ghost"
                onClick={() => setStep("recovery")}
              >
                ← back
              </button>
              {scaffoldResult.kind === "ok" ||
              scaffoldRows.filter((r) => r.enabled).length === 0 ? (
                <button
                  type="button"
                  className="cos-btn cos-btn-primary"
                  onClick={() => setStep("bootstrap")}
                  autoFocus
                >
                  {scaffoldResult.kind === "ok"
                    ? "next →"
                    : scaffoldRows.length === 0
                      ? "skip — set up later from People"
                      : "skip — uncheck all"}
                </button>
              ) : (
                <button
                  type="button"
                  className="cos-btn cos-btn-primary"
                  onClick={runScaffold}
                  disabled={scaffoldResult.kind === "running"}
                >
                  {scaffoldResult.kind === "running"
                    ? "creating…"
                    : `create ${scaffoldRows.filter((r) => r.enabled).length} folder${scaffoldRows.filter((r) => r.enabled).length === 1 ? "" : "s"}`}
                </button>
              )}
            </div>
          </section>
        )}

        {step === "bootstrap" && (
          <section className="cos-wizard-step">
            <h2>Pre-load your workspace?</h2>
            <p className="cos-section-lede">
              Want us to bootstrap your data tree from existing sources
              before you start? Pick what's helpful — every item is
              optional. The longer items run in parallel where possible
              and the wizard waits before advancing. You can keep
              working in another tab while they finish.
            </p>
            <ul className="cos-wizard-bootstrap">
              <li>
                <label className="cos-wizard-bootstrap-row">
                  <input
                    type="checkbox"
                    checked={bootstrapChecked["org-generate"]}
                    disabled={bootstrapRunning}
                    onChange={(e) =>
                      setBootstrapChecked((prev) => ({
                        ...prev,
                        "org-generate": e.target.checked,
                      }))
                    }
                  />
                  <span className="cos-wizard-bootstrap-body">
                    <strong>Generate org tree</strong>
                    <span className="cos-wizard-bootstrap-meta">
                      ~1–2 min · pulls Slack profiles + your team
                      structure into <code>areas/org/org.json</code>
                    </span>
                  </span>
                  <BootstrapStatusChip s={bootstrapStatus["org-generate"]} />
                </label>
              </li>
              <li>
                <label className="cos-wizard-bootstrap-row">
                  <input
                    type="checkbox"
                    checked={bootstrapChecked["people-refresh"]}
                    disabled={bootstrapRunning}
                    onChange={(e) =>
                      setBootstrapChecked((prev) => ({
                        ...prev,
                        "people-refresh": e.target.checked,
                      }))
                    }
                  />
                  <span className="cos-wizard-bootstrap-body">
                    <strong>Refresh people profiles</strong>
                    <span className="cos-wizard-bootstrap-meta">
                      ~30s/person · fills bios, photos, Slack handles
                      for your manager + direct reports
                    </span>
                  </span>
                  <BootstrapStatusChip s={bootstrapStatus["people-refresh"]} />
                </label>
              </li>
              <li>
                <label className="cos-wizard-bootstrap-row">
                  <input
                    type="checkbox"
                    checked={bootstrapChecked["jira-pull"]}
                    disabled={bootstrapRunning}
                    onChange={(e) =>
                      setBootstrapChecked((prev) => ({
                        ...prev,
                        "jira-pull": e.target.checked,
                      }))
                    }
                  />
                  <span className="cos-wizard-bootstrap-body">
                    <strong>Pull your open Jira issues</strong>
                    <span className="cos-wizard-bootstrap-meta">
                      ~20s · indexes your assigned tickets so the Tasks
                      surface has real signal on day one
                    </span>
                  </span>
                  <BootstrapStatusChip s={bootstrapStatus["jira-pull"]} />
                </label>
              </li>
              <li>
                <label className="cos-wizard-bootstrap-row">
                  <input
                    type="checkbox"
                    checked={bootstrapChecked["starter-projects"]}
                    disabled={bootstrapRunning}
                    onChange={(e) =>
                      setBootstrapChecked((prev) => ({
                        ...prev,
                        "starter-projects": e.target.checked,
                      }))
                    }
                  />
                  <span className="cos-wizard-bootstrap-body">
                    <strong>Scaffold starter projects</strong>
                    <span className="cos-wizard-bootstrap-meta">
                      instant · drops README templates for the project
                      kinds below. Projects can be anything you're
                      tracking — career growth, hiring, mentorship,
                      planning, etc.
                    </span>
                    {bootstrapChecked["starter-projects"] && (
                      <span className="cos-wizard-bootstrap-sublist">
                        {(
                          [
                            ["career-development", "Career development", "your own growth, promo prep, leveling targets"],
                            ["hiring-pipeline", "Hiring pipeline", "open reqs, candidates in flight, debriefs"],
                            ["mentorship", "Mentorship", "people you're coaching outside your reporting line"],
                            ["presentation-prep", "Presentation prep", "an upcoming talk, all-hands, or readout"],
                            ["quarterly-planning", "Quarterly planning", "bets, constraints, what you're not doing"],
                            ["new-team-member", "New team member onboarding", "30/60/90 plan for someone joining"],
                          ] as Array<[StarterProjectKind, string, string]>
                        ).map(([id, label, desc]) => (
                          <label
                            key={id}
                            className="cos-wizard-bootstrap-subrow"
                          >
                            <input
                              type="checkbox"
                              checked={starterProjects[id]}
                              disabled={bootstrapRunning}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) =>
                                setStarterProjects((prev) => ({
                                  ...prev,
                                  [id]: e.target.checked,
                                }))
                              }
                            />
                            <span>
                              <strong>{label}</strong>
                              <span className="cos-wizard-bootstrap-subdesc">
                                {desc}
                              </span>
                            </span>
                          </label>
                        ))}
                      </span>
                    )}
                  </span>
                  <BootstrapStatusChip
                    s={bootstrapStatus["starter-projects"]}
                  />
                </label>
              </li>
              <li>
                <label className="cos-wizard-bootstrap-row">
                  <input
                    type="checkbox"
                    checked={bootstrapChecked["reminders-cron"]}
                    disabled={bootstrapRunning}
                    onChange={(e) =>
                      setBootstrapChecked((prev) => ({
                        ...prev,
                        "reminders-cron": e.target.checked,
                      }))
                    }
                  />
                  <span className="cos-wizard-bootstrap-body">
                    <strong>Push overdue tasks to Apple Reminders</strong>
                    <span className="cos-wizard-bootstrap-meta">
                      installs a launchctl agent that runs daily at 8am
                      and creates Apple Reminders for any overdue
                      tasks. Read-only — never mutates your task DB.
                    </span>
                  </span>
                  <BootstrapStatusChip
                    s={bootstrapStatus["reminders-cron"]}
                  />
                </label>
              </li>
              <li>
                <label className="cos-wizard-bootstrap-row">
                  <input
                    type="checkbox"
                    checked={bootstrapChecked["morning-briefing-cron"]}
                    disabled={bootstrapRunning}
                    onChange={(e) =>
                      setBootstrapChecked((prev) => ({
                        ...prev,
                        "morning-briefing-cron": e.target.checked,
                      }))
                    }
                  />
                  <span className="cos-wizard-bootstrap-body">
                    <strong>Schedule morning briefing (daily 7am)</strong>
                    <span className="cos-wizard-bootstrap-meta">
                      installs a launchctl agent that runs{" "}
                      <code>/morning-briefing</code> daily — the
                      briefing pulls calendar, tasks, 1:1 prep, and
                      Slack signals into{" "}
                      <code>areas/daily-briefings/</code>.
                    </span>
                  </span>
                  <BootstrapStatusChip
                    s={bootstrapStatus["morning-briefing-cron"]}
                  />
                </label>
              </li>
              <li>
                <label className="cos-wizard-bootstrap-row">
                  <input
                    type="checkbox"
                    checked={bootstrapChecked["weekly-review-cron"]}
                    disabled={bootstrapRunning}
                    onChange={(e) =>
                      setBootstrapChecked((prev) => ({
                        ...prev,
                        "weekly-review-cron": e.target.checked,
                      }))
                    }
                  />
                  <span className="cos-wizard-bootstrap-body">
                    <strong>Schedule weekly review (Friday 8pm)</strong>
                    <span className="cos-wizard-bootstrap-meta">
                      installs a launchctl agent that runs{" "}
                      <code>/weekly-review</code> every Friday — task
                      triage, project health check, and session
                      compaction.
                    </span>
                  </span>
                  <BootstrapStatusChip
                    s={bootstrapStatus["weekly-review-cron"]}
                  />
                </label>
              </li>
            </ul>
            <p className="cos-helper-text">
              <strong>Tip:</strong> if Claude isn't connected yet, these
              skills will fail — finish the Claude step first, then come
              back here from Settings → Diagnostics.
            </p>
            <div className="cos-wizard-actions">
              <button
                type="button"
                className="cos-btn cos-btn-ghost"
                onClick={() => setStep("first-person")}
              >
                ← back
              </button>
              <button
                type="button"
                className="cos-btn cos-btn-ghost"
                onClick={() => setStep("done")}
                disabled={bootstrapRunning}
              >
                skip — start fresh
              </button>
              <button
                type="button"
                className="cos-btn cos-btn-primary"
                onClick={async () => {
                  await runBootstrap();
                  // Don't auto-advance — let the user see the
                  // results, then click "next →" themselves.
                }}
                disabled={
                  bootstrapRunning ||
                  Object.values(bootstrapChecked).every((v) => !v)
                }
              >
                {bootstrapRunning
                  ? "running…"
                  : Object.values(bootstrapStatus).some(
                        (s) => s.kind === "ok" || s.kind === "skipped",
                      )
                    ? "next →"
                    : "run selected"}
              </button>
            </div>
            {Object.values(bootstrapStatus).some(
              (s) => s.kind === "ok" || s.kind === "error" || s.kind === "skipped",
            ) && (
              <p className="cos-helper-text">
                Done — review the results above, then{" "}
                <button
                  type="button"
                  className="cos-btn-link"
                  onClick={() => setStep("done")}
                >
                  continue →
                </button>
              </p>
            )}
          </section>
        )}

        {step === "done" && (
          <section className="cos-wizard-step cos-wizard-done">
            <h2>You're all set 🎉</h2>
            <p className="cos-section-lede">
              Everything's wired. Here's what's now connected:
            </p>
            <ul className="cos-wizard-recap">
              {claudeCheck && (
                <li>
                  <span
                    className={claudeCheck.ok ? "cos-good" : "cos-bad"}
                  >
                    {claudeCheck.ok ? "✓" : "✗"}
                  </span>{" "}
                  Claude Code —{" "}
                  {claudeCheck.ok
                    ? "ready to draft, prep, and digest on your behalf"
                    : "not connected; reach Settings → Claude when you're ready"}
                </li>
              )}
              {calCheck && (
                <li>
                  <span className={calCheck.ok ? "cos-good" : "cos-bad"}>
                    {calCheck.ok ? "✓" : "✗"}
                  </span>{" "}
                  Calendar —{" "}
                  {calCheck.ok
                    ? "today's meetings appear on Home"
                    : "not connected; reach Settings → Calendar when you're ready"}
                </li>
              )}
              {contentCheck && (
                <li>
                  <span
                    className={contentCheck.ok ? "cos-good" : "cos-bad"}
                  >
                    {contentCheck.ok ? "✓" : "✗"}
                  </span>{" "}
                  Data folder —{" "}
                  {contentCheck.ok
                    ? "your notes, sessions, and tasks live here"
                    : "couldn't reach the folder; check Settings → Data folder"}
                </li>
              )}
            </ul>
            <h3 className="cos-wizard-subhead">Three things to try first</h3>
            <ol className="cos-wizard-tries">
              <li>
                Click <strong>People</strong> in the sidebar → open
                anyone you set up → press the <strong>"Prep 1:1"</strong>{" "}
                button. Claude reads their README + recent sessions,
                gathers Slack signal, and drafts a shared-agenda doc
                you can paste into Google Docs. <strong>Try this first</strong>{" "}
                — that's the moment the app earns its keep.
              </li>
              <li>
                On <strong>Home</strong>, hit the <strong>"Brief"</strong>{" "}
                button to generate today's morning briefing — calendar +
                attention items + Slack signal + tasks, all in one
                drafted doc.
              </li>
              <li>
                On <strong>Tasks</strong>, the <strong>"Triage"</strong>{" "}
                button surfaces overdue and stale tasks for review with
                suggested actions (re-date, drop, delegate). Run it
                whenever the list feels heavy.
              </li>
            </ol>
            <p className="cos-helper-text cos-wizard-power-user">
              <strong>Power user?</strong> Every UI button is also a
              slash command (<code>/prep-1on1</code>,{" "}
              <code>/morning-briefing</code>, <code>/task-triage</code>)
              you can run directly from Claude Code in your terminal.
              The buttons are the easier path; the CLI is there when
              you want to script something.
            </p>
            <div className="cos-wizard-actions">
              <button
                type="button"
                className="cos-btn cos-btn-primary"
                onClick={() => finish("done")}
                autoFocus
              >
                open the app
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function Stepper({
  step,
  onJump,
}: {
  step: Step;
  /** Click handler for jumping to a step. Only fires for completed
   *  steps (i.e., backwards-only) so users can revisit a prior
   *  decision without breaking forward state in unexpected ways. */
  onJump: (target: Step) => void;
}) {
  // The numbered steps. "welcome" and "done" are not in the
  // numbered sequence — welcome is the intro, done is the outro.
  // The first-prep / first-brief steps are placeholders for
  // deferred 0.5.6 / 0.5.7 work and don't render in the stepper
  // until they're real screens.
  const order: Step[] = [
    "identity",
    "data",
    "claude",
    "calendar",
    "recovery",
    "first-person",
    "bootstrap",
  ];
  // On welcome, treat all steps as upcoming; on done, treat all
  // as complete. Otherwise look up the active index.
  const activeIdx =
    step === "welcome" ? -1 : step === "done" ? order.length : order.indexOf(step);
  return (
    <ol className="cos-wizard-stepper" aria-label="Setup progress">
      {order.map((id, i) => {
        const state =
          i < activeIdx ? "complete" : i === activeIdx ? "active" : "upcoming";
        const clickable = state === "complete";
        return (
          <li
            key={id}
            className={`cos-wizard-step-pill is-${state} ${clickable ? "is-clickable" : ""}`}
            aria-current={state === "active" ? "step" : undefined}
          >
            {clickable ? (
              <button
                type="button"
                className="cos-wizard-step-button"
                onClick={() => onJump(id)}
                aria-label={`Go back to ${labelForStep(id)}`}
                title={`Go back to ${labelForStep(id)}`}
              >
                <span className="cos-wizard-step-marker" aria-hidden>
                  ✓
                </span>
              </button>
            ) : (
              <span
                className="cos-wizard-step-content"
                title={labelForStep(id)}
              >
                <span className="cos-wizard-step-marker" aria-hidden>
                  {i + 1}
                </span>
                {state === "active" && (
                  <span className="cos-wizard-step-label">
                    {labelForStep(id)}
                  </span>
                )}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** Render an RFC-3339 timestamp as a tight "10:30 AM" / "2:15 PM"
 *  string in the user's locale. Used in the calendar preview. */
function formatEventTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** Small status chip shown next to each bootstrap row. */
function BootstrapStatusChip({
  s,
}: {
  s:
    | { kind: "pending" }
    | { kind: "running" }
    | { kind: "ok"; summary: string }
    | { kind: "skipped" }
    | { kind: "error"; message: string };
}) {
  if (s.kind === "pending") return null;
  if (s.kind === "running") {
    return (
      <span className="cos-wizard-bootstrap-chip is-running">
        <span className="cos-wizard-probe-spinner" aria-hidden /> running
      </span>
    );
  }
  if (s.kind === "ok") {
    return (
      <span className="cos-wizard-bootstrap-chip is-ok" title={s.summary}>
        ✓ {s.summary}
      </span>
    );
  }
  if (s.kind === "skipped") {
    return (
      <span className="cos-wizard-bootstrap-chip is-skipped">skipped</span>
    );
  }
  return (
    <span className="cos-wizard-bootstrap-chip is-error" title={s.message}>
      ✗ failed
    </span>
  );
}

function labelForStep(s: Step): string {
  switch (s) {
    case "welcome":
      return "Welcome";
    case "identity":
      return "About you";
    case "data":
      return "Data";
    case "claude":
      return "Claude";
    case "calendar":
      return "Calendar";
    case "recovery":
      return "Recovery";
    case "first-person":
      return "First 1:1";
    case "bootstrap":
      return "Bootstrap";
    case "first-prep":
      return "Prep";
    case "first-brief":
      return "Briefing";
    case "done":
      return "Done";
  }
}
