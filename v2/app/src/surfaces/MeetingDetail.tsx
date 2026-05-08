import { lazy, Suspense, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { newSessionForOwner } from "../state/newSession";
import { type OpenDoc } from "../state/openDoc";
import { SectionHeader, SnippetCard } from "../ui";
import { type SessionMeta } from "./Meetings";

// Lazy-loaded MarkdownView so the Tiptap chunk only fetches when a
// meeting README actually renders. Mirrors PersonProfile + ProjectDetail.
const MarkdownView = lazy(() =>
  import("./MarkdownView").then((m) => ({ default: m.MarkdownView })),
);

export type MeetingTarget = {
  slug: string;
  label: string;
  rel_path: string;
};

type Load =
  | { kind: "loading" }
  | { kind: "ok"; readme: string | null; sessions: SessionMeta[] }
  | { kind: "error"; error: string };

type DocFile = { rel_path: string; markdown: string };

/**
 * Meeting detail — read-mode view for a single recurring meeting.
 * Mirrors PersonProfile / ProjectDetail: hero with the meeting name +
 * back button, sessions surfaced prominently at the top (the analog of
 * sessions on a person page), then the README rendered inline. Edit
 * goes through the standard DocEditor via the "edit" button.
 */
export function MeetingDetail({
  target,
  onOpenDoc,
  onBack,
}: {
  target: MeetingTarget;
  onOpenDoc: (doc: OpenDoc) => void;
  onBack: () => void;
}) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });

  const refreshSessions = async () => {
    try {
      const sessions = await invoke<SessionMeta[]>("content_list_sessions", {
        relPath: target.rel_path,
        limit: 0,
      });
      setLoad((cur) =>
        cur.kind === "ok" ? { ...cur, sessions } : cur,
      );
    } catch {
      // Non-fatal — list keeps showing the previous snapshot.
    }
  };

  useEffect(() => {
    let cancelled = false;
    setLoad({ kind: "loading" });
    (async () => {
      try {
        const [sessions, readmeResult] = await Promise.all([
          invoke<SessionMeta[]>("content_list_sessions", {
            relPath: target.rel_path,
            limit: 0,
          }),
          (async () => {
            try {
              const doc = await invoke<DocFile>("content_read_file", {
                relPath: `${target.rel_path}/README.md`,
              });
              return doc.markdown;
            } catch {
              // Meeting may not have a README yet.
              return null;
            }
          })(),
        ]);
        if (!cancelled) setLoad({ kind: "ok", readme: readmeResult, sessions });
      } catch (error) {
        if (!cancelled) setLoad({ kind: "error", error: String(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target.rel_path]);

  const openReadme = () =>
    onOpenDoc({
      relPath: `${target.rel_path}/README.md`,
      label: "README",
      crumbs: [{ label: target.label, meeting: target }],
    });

  const openSession = (s: SessionMeta) =>
    onOpenDoc({
      relPath: s.rel_path,
      label: s.date,
      crumbs: [{ label: target.label, meeting: target }],
    });

  const newSession = async () => {
    const result = await newSessionForOwner(target.rel_path, target.label);
    if (result.error || !result.relPath) {
      window.alert(result.error ?? "could not create session");
      return;
    }
    // Refresh the sessions list so the new entry shows up under the
    // hero, then route into the file.
    await refreshSessions();
    const date = result.relPath.split("/").pop()?.replace(/\.md$/, "") ?? "";
    onOpenDoc({
      relPath: result.relPath,
      label: date,
      crumbs: [{ label: target.label, meeting: target }],
    });
  };

  // Back navigation lives in the header breadcrumb (`Meetings > <Name>`).
  // onBack is preserved in the public contract for callers that still
  // pass it but is no longer wired to a button on the surface itself.
  void onBack;

  return (
    <div className="cos-project-detail">
      <header className="cos-project-detail-hero">
        <h1>{target.label}</h1>
        <code className="cos-project-detail-path">{target.rel_path}</code>
      </header>

      {load.kind === "loading" && (
        <div className="cos-empty">Loading meeting…</div>
      )}
      {load.kind === "error" && (
        <div className="cos-empty cos-empty-error">
          Could not load meeting: {load.error}
        </div>
      )}
      {load.kind === "ok" && (
        <>
          <section className="cos-project-detail-files">
            <SectionHeader
              label="Recent sessions"
              count={load.sessions.length}
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
            {load.sessions.length === 0 ? (
              <div className="cos-empty">
                No sessions yet. After your next meeting, a dated file will
                land in <code>sessions/</code>.
              </div>
            ) : (
              <div className="cos-profile-snippet-grid">
                {load.sessions.slice(0, 6).map((s) => (
                  <SnippetCard
                    key={s.rel_path}
                    date={s.date}
                    relative={staleLabel(s.date)}
                    onOpen={() => openSession(s)}
                  />
                ))}
                {load.sessions.length > 6 && (
                  <ul className="cos-profile-session-list cos-profile-session-list-overflow">
                    {load.sessions.slice(6).map((s) => (
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
                load.readme ? (
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
            {load.readme ? (
              <div className="cos-profile-readme-body">
                <Suspense fallback={<div className="cos-empty">…</div>}>
                  <MarkdownView
                    markdown={load.readme}
                    relPath={`${target.rel_path}/README.md`}
                  />
                </Suspense>
              </div>
            ) : (
              <div className="cos-empty">
                No README yet — add one to capture the meeting's standing
                agenda, attendees, and how it gets prepped.{" "}
                <button
                  type="button"
                  className="cos-btn cos-btn-ghost"
                  onClick={openReadme}
                >
                  start one
                </button>
              </div>
            )}
          </section>
        </>
      )}
    </div>
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
