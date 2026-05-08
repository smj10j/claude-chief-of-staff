import { lazy, Suspense, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { type OpenDoc } from "../state/openDoc";
import { SectionHeader, SnippetCard } from "../ui";
import { type ProjectFile } from "./Projects";

// Lazy-loaded MarkdownView so the Tiptap chunk only fetches when a
// project README actually renders. Mirrors PersonProfile.
const MarkdownView = lazy(() =>
  import("./MarkdownView").then((m) => ({ default: m.MarkdownView })),
);

export type ProjectTarget = {
  slug: string;
  label: string;
  rel_path: string;
};

type Load =
  | { kind: "loading" }
  | { kind: "ok"; readme: string | null; files: ProjectFile[] }
  | { kind: "error"; error: string };

type DocFile = { rel_path: string; markdown: string };

/**
 * Project detail — a read-mode view for a single project. Mirrors the
 * PersonProfile pattern: a hero with the project name + back button,
 * the project's files surfaced prominently at the top (the analog of
 * sessions on a person page), then the README rendered inline. Edit
 * goes through the standard DocEditor via the "edit" button.
 */
export function ProjectDetail({
  target,
  onOpenDoc,
  onBack,
}: {
  target: ProjectTarget;
  onOpenDoc: (doc: OpenDoc) => void;
  onBack: () => void;
}) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setLoad({ kind: "loading" });
    (async () => {
      try {
        const [files, readmeResult] = await Promise.all([
          invoke<ProjectFile[]>("content_list_project_files", {
            relPath: target.rel_path,
          }),
          (async () => {
            try {
              const doc = await invoke<DocFile>("content_read_file", {
                relPath: `${target.rel_path}/README.md`,
              });
              return doc.markdown;
            } catch {
              // Project may not have a README yet.
              return null;
            }
          })(),
        ]);
        if (!cancelled) setLoad({ kind: "ok", readme: readmeResult, files });
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
      crumbs: [{ label: target.label, project: target }],
    });

  const openFile = (f: ProjectFile) =>
    onOpenDoc({
      relPath: f.rel_path,
      label: f.name.replace(/\.(md|html)$/, ""),
      crumbs: [{ label: target.label, project: target }],
    });

  // Drop README from the files list — it's rendered inline below.
  const otherFiles =
    load.kind === "ok"
      ? load.files.filter((f) => !f.rel_path.endsWith("/README.md"))
      : [];

  // Back navigation lives in the header breadcrumb (`Projects > <Name>`).
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
        <div className="cos-empty">Loading project…</div>
      )}
      {load.kind === "error" && (
        <div className="cos-empty cos-empty-error">
          Could not load project: {load.error}
        </div>
      )}
      {load.kind === "ok" && (
        <>
          <section className="cos-project-detail-files">
            <SectionHeader label="Files" count={otherFiles.length} />
            {otherFiles.length === 0 ? (
              <div className="cos-empty">
                No additional files yet — the README is the only doc in this
                project.
              </div>
            ) : (
              <div className="cos-profile-snippet-grid">
                {otherFiles.map((f) => (
                  <SnippetCard
                    key={f.rel_path}
                    date={f.name.replace(/\.(md|html)$/, "")}
                    onOpen={() => openFile(f)}
                  />
                ))}
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
                No README yet — add one to give this project a clear summary,
                goals, and current status.{" "}
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
