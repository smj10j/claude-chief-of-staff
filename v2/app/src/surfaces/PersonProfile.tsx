import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, Mail } from "lucide-react";

import { newSessionForOwner } from "../state/newSession";
import { type OpenDoc } from "../state/openDoc";
import { dismissRun, runSkill, useRun } from "../state/skillRuns";
import { SectionHeader, SnippetCard } from "../ui";

// Lazy so the Tiptap chunk doesn't load until a profile actually
// renders a README. Cold-start to Home/Tasks/Settings stays light.
const MarkdownView = lazy(() =>
  import("./MarkdownView").then((m) => ({ default: m.MarkdownView })),
);

export type ProfileTarget = {
  slug: string;
  label: string;
  rel_path: string;
};

type SessionMeta = { date: string; rel_path: string };

type PersonMeta = {
  title?: string | null;
  email?: string | null;
  photo_url?: string | null;
  slack_url?: string | null;
  /** B9-CP30 fields. Optional. */
  github_login?: string | null;
  paging_id?: string | null;
};

type ProfilePayload = {
  rel_path: string;
  readme: string | null;
  sessions: SessionMeta[];
  meta?: PersonMeta | null;
};

type Load =
  | { kind: "loading" }
  | { kind: "ok"; profile: ProfilePayload }
  | { kind: "error"; error: string };

export function PersonProfile({
  target,
  onOpenDoc,
  onBack,
}: {
  target: ProfileTarget;
  onOpenDoc: (doc: OpenDoc) => void;
  onBack: () => void;
}) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const refreshId = `person-refresh:${target.slug}`;
  const prepId = `prep-1on1:${target.slug}`;
  const refreshRun = useRun(refreshId);
  const prepRun = useRun(prepId);
  const refreshing = refreshRun?.state === "running";
  const prepping = prepRun?.state === "running";
  const refreshError = refreshRun?.state === "error" ? refreshRun.error ?? null : null;
  const prepError = prepRun?.state === "error" ? prepRun.error ?? null : null;

  useEffect(() => {
    let cancelled = false;
    setLoad({ kind: "loading" });
    (async () => {
      try {
        const profile = await invoke<ProfilePayload>("content_person_profile", {
          relPath: target.rel_path,
          limit: 10,
        });
        if (!cancelled) setLoad({ kind: "ok", profile });
      } catch (error) {
        if (!cancelled) setLoad({ kind: "error", error: String(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target.rel_path]);

  const prep = () => {
    if (prepping) return;
    runSkill(prepId, `Prep 1:1 — ${target.label}`, async () => {
      const result = await invoke<{ rel_path: string; summary: string }>(
        "person_prep",
        { slug: target.slug },
      );
      // Open the saved session file in the editor immediately if the
      // user is still on this profile. If they've navigated away,
      // they'll see the completed run when they return and can act
      // (the `lastSeenPrepGen` effect below handles the open-on-mount).
      const date = result.rel_path
        .split("/")
        .pop()
        ?.replace(/\.md$/, "") ?? "";
      onOpenDoc({
        relPath: result.rel_path,
        label: date,
        crumbs: [{ label: target.label, profile: target }],
      });
      return result;
    }).catch(() => {
      /* error already captured in run state */
    });
  };

  const refresh = () => {
    if (refreshing) return;
    runSkill(refreshId, `Refresh — ${target.label}`, async () => {
      const profile = await invoke<ProfilePayload>("person_refresh", {
        relPath: target.rel_path,
        slug: target.slug,
      });
      setLoad({ kind: "ok", profile });
      return profile;
    }).catch(() => {
      /* error already captured in run state */
    });
  };

  // Reload the profile from disk after a refresh completes, even if it
  // started on a different mount (user clicked refresh, navigated away,
  // came back). `generation` increments only on completion.
  const lastRefreshGen = useRef(refreshRun?.generation ?? 0);
  useEffect(() => {
    const gen = refreshRun?.generation ?? 0;
    if (gen > lastRefreshGen.current && refreshRun?.state === "done") {
      lastRefreshGen.current = gen;
      invoke<ProfilePayload>("content_person_profile", {
        relPath: target.rel_path,
        limit: 10,
      })
        .then((profile) => setLoad({ kind: "ok", profile }))
        .catch(() => { /* keep current */ });
    }
  }, [refreshRun, target.rel_path]);

  const openSession = (s: SessionMeta) =>
    onOpenDoc({
      relPath: s.rel_path,
      label: s.date,
      crumbs: [{ label: target.label, profile: target }],
    });

  const newSession = async () => {
    const result = await newSessionForOwner(target.rel_path, target.label);
    if (result.error || !result.relPath) {
      window.alert(result.error ?? "could not create session");
      return;
    }
    // Refresh the profile so the session list shows the new entry,
    // then route the user into it.
    try {
      const profile = await invoke<ProfilePayload>("content_person_profile", {
        relPath: target.rel_path,
        limit: 10,
      });
      setLoad({ kind: "ok", profile });
    } catch {
      // Non-fatal — the editor still opens; profile will refresh on
      // next navigation.
    }
    const date = result.relPath.split("/").pop()?.replace(/\.md$/, "") ?? "";
    onOpenDoc({
      relPath: result.relPath,
      label: date,
      crumbs: [{ label: target.label, profile: target }],
    });
  };

  const openReadme = () =>
    onOpenDoc({
      relPath: `${target.rel_path}/README.md`,
      label: "README",
      crumbs: [{ label: target.label, profile: target }],
    });

  const meta = load.kind === "ok" ? load.profile.meta ?? null : null;

  // Back navigation lives in the header breadcrumb (`People > <Person>`).
  // onBack is preserved in the public contract for callers that still
  // pass it but is no longer wired to a button on the surface itself.
  void onBack;

  return (
    <div className="cos-profile">
      <div className="cos-profile-hero">
        <Avatar label={target.label} photoUrl={meta?.photo_url ?? null} />
        <div className="cos-profile-hero-main">
          <div className="cos-profile-hero-row">
            <h1>{target.label}</h1>
            <div className="cos-profile-hero-actions">
              <button
                type="button"
                className="cos-btn"
                onClick={prep}
                disabled={prepping}
                title="Generate a 1:1 prep doc using README, recent sessions, and tasks"
              >
                {prepping ? (
                  <>
                    <span className="cos-newtask-spinner" aria-hidden />
                    prepping…
                  </>
                ) : (
                  "Prep 1:1"
                )}
              </button>
              <button
                type="button"
                className="cos-btn cos-btn-ghost cos-profile-refresh"
                onClick={refresh}
                disabled={refreshing}
                title="Look up Slack ID, photo URL, email via MCP connectors"
              >
                {refreshing ? (
                  <>
                    <span className="cos-newtask-spinner" aria-hidden />
                    refreshing…
                  </>
                ) : (
                  "refresh"
                )}
              </button>
            </div>
          </div>
          {meta?.title && (
            <div className="cos-profile-hero-title">{meta.title}</div>
          )}
          <div className="cos-profile-hero-links">
            {meta?.slack_url && (
              <a
                className="cos-profile-link"
                href={meta.slack_url}
                target="_blank"
                rel="noreferrer"
                title="Open Slack profile"
              >
                <span className="cos-profile-link-icon">#</span>
                Slack
                <ExternalLink size={11} aria-hidden />
              </a>
            )}
            {meta?.email && (
              <span className="cos-profile-email-group">
                <a
                  className="cos-profile-link"
                  href={`mailto:${meta.email}`}
                  title={`Email ${meta.email}`}
                >
                  <Mail size={12} aria-hidden />
                  {meta.email}
                </a>
                <button
                  type="button"
                  className="cos-profile-link-copy"
                  onClick={(e) => {
                    e.preventDefault();
                    if (!meta.email) return;
                    navigator.clipboard?.writeText(meta.email).catch(() => {});
                  }}
                  aria-label={`Copy ${meta.email} to clipboard`}
                  title="Copy email"
                >
                  copy
                </button>
              </span>
            )}
            {!meta?.slack_url && !meta?.email && load.kind === "ok" && (
              <span className="cos-profile-hero-hint">
                Click <strong>refresh</strong> to have Claude pull Slack +
                email via your MCP connectors, or hand-edit{" "}
                <code>person.json</code>.
              </span>
            )}
          </div>
          {refreshing && (
            <div
              className="cos-newtask-status"
              role="status"
              aria-live="polite"
            >
              Claude is looking up {target.label} via MCPs…
            </div>
          )}
          {prepping && (
            <div
              className="cos-newtask-status"
              role="status"
              aria-live="polite"
            >
              Claude is drafting the 1:1 prep — this can take a minute…
            </div>
          )}
          {prepError && (
            <div className="cos-newtask-error">
              Prep failed: {prepError}
              <button
                type="button"
                className="cos-btn cos-btn-ghost"
                onClick={() => dismissRun(prepId)}
                style={{ marginLeft: 8 }}
              >
                dismiss
              </button>
            </div>
          )}
          {refreshError && (
            <div className="cos-newtask-error">
              Refresh failed: {refreshError}
              <button
                type="button"
                className="cos-btn cos-btn-ghost"
                onClick={() => dismissRun(refreshId)}
                style={{ marginLeft: 8 }}
              >
                dismiss
              </button>
            </div>
          )}
        </div>
      </div>

      {load.kind === "loading" && (
        <div className="cos-empty">Loading profile…</div>
      )}
      {load.kind === "error" && (
        <div className="cos-empty cos-empty-error">
          Could not load profile: {load.error}
        </div>
      )}
      {load.kind === "ok" && (
        <>
          {load.profile.meta?.github_login && (
            <PersonOpenPrs login={load.profile.meta.github_login} />
          )}
          {load.profile.meta?.paging_id && (
            <PersonOnCallShifts userId={load.profile.meta.paging_id} />
          )}
          <section className="cos-profile-sessions">
            <SectionHeader
              label="Recent sessions"
              count={load.profile.sessions.length}
              trailing={
                <button
                  type="button"
                  className="cos-btn cos-btn-ghost"
                  onClick={newSession}
                  title="Create today's session file with the standard template"
                >
                  + new session
                </button>
              }
            />
            {load.profile.sessions.length === 0 ? (
              <div className="cos-empty">
                No sessions yet. After your next 1:1, a dated file lands in{" "}
                <code>sessions/</code>.
              </div>
            ) : (
              <div className="cos-profile-snippet-grid">
                {load.profile.sessions.slice(0, 6).map((s) => (
                  <SnippetCard
                    key={s.rel_path}
                    date={s.date}
                    relative={staleLabel(s.date)}
                    onOpen={() => openSession(s)}
                  />
                ))}
                {load.profile.sessions.length > 6 && (
                  <ul className="cos-profile-session-list cos-profile-session-list-overflow">
                    {load.profile.sessions.slice(6).map((s) => (
                      <li key={s.rel_path}>
                        <button
                          type="button"
                          className="cos-profile-session-row"
                          onClick={() => openSession(s)}
                        >
                          <span className="cos-profile-session-date">
                            {s.date}
                          </span>
                          <span className="cos-profile-session-stale">
                            {staleLabel(s.date)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>

          <section className="cos-profile-readme">
            <SectionHeader
              label="README"
              trailing={
                load.profile.readme ? (
                  <button
                    type="button"
                    className="cos-btn cos-btn-ghost"
                    onClick={openReadme}
                  >
                    edit
                  </button>
                ) : undefined
              }
            />
            {load.profile.readme ? (
              <div className="cos-profile-readme-body">
                <Suspense fallback={<div className="cos-empty">…</div>}>
                  <MarkdownView
                    markdown={load.profile.readme}
                    relPath={`${target.rel_path}/README.md`}
                  />
                </Suspense>
              </div>
            ) : (
              <div className="cos-empty">
                No README yet — add one to collect persistent context
                (priorities, coaching notes, relationship backstory).
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function Avatar({
  label,
  photoUrl,
}: {
  label: string;
  photoUrl: string | null;
}) {
  if (photoUrl) {
    return (
      <img
        className="cos-profile-avatar cos-profile-avatar-img"
        src={photoUrl}
        alt={`${label} avatar`}
      />
    );
  }
  // Initials fallback: first letter of up to two whitespace-separated words.
  const initials = label
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  return (
    <div className="cos-profile-avatar cos-profile-avatar-initials" aria-hidden>
      {initials}
    </div>
  );
}

// =============================================================
// B9-CP31 — Open PRs section on Person Profile, when github_login
// is set on person.json. Lazy fetches via gh search prs.
// =============================================================

type ProfilePr = {
  number: number;
  title: string;
  url: string;
  repo: string;
  is_draft: boolean;
  updated_at: string;
};

function PersonOpenPrs({ login }: { login: string }) {
  const [rows, setRows] = useState<ProfilePr[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    invoke<ProfilePr[]>("gh_prs_for_author", { login, limit: 10 })
      .then((r) => {
        if (!cancelled) setRows(r);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [login]);
  if (error) return null;
  if (!rows || rows.length === 0) return null;
  return (
    <section className="cos-profile-prs">
      <SectionHeader label="Open PRs" count={rows.length} />
      <ul className="cos-pr-list">
        {rows.map((pr) => (
          <li key={pr.url}>
            <button
              type="button"
              className="cos-pr-row"
              onClick={() => openUrl(pr.url).catch(() => {})}
            >
              <div className="cos-pr-head">
                <span className="cos-pr-repo">{pr.repo}</span>
                <span className="cos-pr-num">#{pr.number}</span>
                {pr.is_draft && (
                  <span className="cos-chip cos-chip-muted">draft</span>
                )}
              </div>
              <div className="cos-pr-title">{pr.title}</div>
              <div className="cos-pr-meta">
                updated {staleLabel(pr.updated_at)}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// =============================================================
// B9-CP33 — Upcoming on-call shifts on Person Profile, when
// paging_id is set on person.json. Lazy fetches via the paging
// IPC; window is 14 days.
// =============================================================

type ProfileShift = {
  schedule_id: string;
  schedule_name: string;
  start: string;
  end: string;
  level: number;
};

function PersonOnCallShifts({ userId }: { userId: string }) {
  const [shifts, setShifts] = useState<ProfileShift[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    invoke<ProfileShift[]>("paging_user_shifts", { userId, days: 14 })
      .then((r) => {
        if (!cancelled) setShifts(r);
      })
      .catch(() => {
        if (!cancelled) setShifts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);
  if (!shifts || shifts.length === 0) return null;
  return (
    <section className="cos-profile-shifts">
      <SectionHeader label="Upcoming on-call (14d)" count={shifts.length} />
      <ul className="cos-pr-list">
        {shifts.map((s, ix) => (
          <li key={`${s.schedule_id}-${ix}`}>
            <div className="cos-pr-row">
              <div className="cos-pr-head">
                <span className="cos-pr-repo">{s.schedule_name}</span>
                <span
                  className={`cos-oncall-level cos-oncall-level-${s.level}`}
                >
                  L{s.level}
                </span>
              </div>
              <div className="cos-pr-meta">
                {s.start.slice(0, 10)} → {s.end.slice(0, 10)}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function staleLabel(date: string): string {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const target = new Date(d);
  target.setHours(0, 0, 0, 0);
  const days = Math.round((now.getTime() - target.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days}d ago`;
  if (days < 60) return `${Math.round(days / 7)}w ago`;
  return `${Math.round(days / 30)}mo ago`;
}
