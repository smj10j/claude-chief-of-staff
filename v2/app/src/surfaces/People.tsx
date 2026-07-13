import { type MouseEvent, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { type OpenDoc } from "../state/openDoc";
import { dismissRun, runSkill, useRun } from "../state/skillRuns";
import { intentFromEvent, type OpenIntent } from "../state/tabs";
import { PersonCard, SectionHeader, SurfaceHero } from "../ui";
import { OrgViewPanel, type OrgView } from "./OrgView";
import { PersonProfile, type ProfileTarget } from "./PersonProfile";

export type PersonRef = {
  slug: string;
  label: string;
  relationship: string;
  rel_path: string;
  has_readme: boolean;
  session_count: number;
  last_session: string | null;
  title?: string | null;
  photo_url?: string | null;
};

/** PRD-115 §6.3 — Needs-your-attention hero. Backend feed (B3-CP2). */
type AttentionPerson = {
  slug: string;
  label: string;
  relationship: string;
  rel_path: string;
  days_since_last_session: number | null;
  reasons: string[];
};

type OrgFile = { views: OrgView[] };

type Load =
  | { kind: "loading" }
  | { kind: "ok"; people: PersonRef[] }
  | { kind: "error"; error: string };

type OrgLoad =
  | { kind: "loading" }
  | { kind: "ok"; file: OrgFile }
  | { kind: "error"; error: string };

type Props = {
  onOpenDoc: (doc: OpenDoc) => void;
  profile: ProfileTarget | null;
  onGoToProfile: (target: ProfileTarget, intent?: OpenIntent) => void;
  onClearProfile: () => void;
};

type TabId = string;

const ATTENTION_EXPANDED_KEY = "cos:people-attention-expanded";


export function People({
  onOpenDoc,
  profile,
  onGoToProfile,
  onClearProfile,
}: Props) {
  // `tab` and the loaders live on People (not on the inner directory/org
  // component) so they survive navigation to a profile and back. Opening
  // a profile swaps which child renders but doesn't unmount People — the
  // tab the user was on when they clicked into a person is the tab they
  // return to when they hit Back.
  const orgRun = useRun("org-generate");
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [orgLoad, setOrgLoad] = useState<OrgLoad>({ kind: "loading" });
  const [tab, setTab] = useState<TabId>("");
  const [attention, setAttention] = useState<AttentionPerson[]>([]);
  const [attentionExpanded, setAttentionExpanded] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(ATTENTION_EXPANDED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"last" | "name" | "staleness">("last");

  useEffect(() => {
    try {
      sessionStorage.setItem(
        ATTENTION_EXPANDED_KEY,
        attentionExpanded ? "1" : "0",
      );
    } catch {
      /* sessionStorage may be denied */
    }
  }, [attentionExpanded]);

  const todayDate = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const people = await invoke<PersonRef[]>("content_list_people");
        if (!cancelled) setLoad({ kind: "ok", people });
      } catch (error) {
        if (!cancelled) setLoad({ kind: "error", error: String(error) });
      }
      try {
        const list = await invoke<AttentionPerson[]>(
          "content_attention_people",
          { today: todayDate, staleDays: 14 },
        );
        if (!cancelled) setAttention(list);
      } catch {
        if (!cancelled) setAttention([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [todayDate]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const file = await invoke<OrgFile>("org_load");
        if (!cancelled) setOrgLoad({ kind: "ok", file });
      } catch (error) {
        if (!cancelled) setOrgLoad({ kind: "error", error: String(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const orgViews: OrgView[] =
    orgLoad.kind === "ok" ? orgLoad.file.views : [];

  // After each completed generator run (success OR failure), reload
  // org_load so the UI picks up whatever landed on disk. The store's
  // `generation` counter increments on completion regardless of which
  // surface the user was on, so this fires correctly even after a
  // nav-away during the run.
  const orgRunGen = orgRun?.generation ?? 0;
  useEffect(() => {
    if (orgRunGen === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const file = await invoke<OrgFile>("org_load");
        if (!cancelled) {
          setOrgLoad({ kind: "ok", file });
          if (file.views.length > 0 && !file.views.some((v) => v.id === tab)) {
            setTab(file.views[0].id);
          }
        }
      } catch {
        // leave current orgLoad state; error banner already covers it
      }
    })();
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgRunGen]);

  // No more Directory tab. Pin tab to the first org view that exists;
  // when org views are empty (fresh install), `activeOrgView` is null
  // and the surface renders the "build an org view" empty state.
  useEffect(() => {
    if (orgViews.length === 0) return;
    if (orgViews.some((v) => v.id === tab)) return;
    setTab(orgViews[0]!.id);
  }, [orgViews, tab]);
  const activeOrgView = orgViews.find((v) => v.id === tab);

  // People with 1:1 folders that no org view references — surfaces the
  // "had folder, didn't end up in any org tree" gap so they're not
  // silently invisible after we removed the Directory tab.
  const slugsInOrg = new Set<string>();
  for (const v of orgViews) {
    for (const n of v.hierarchy) if (n.slug) slugsInOrg.add(n.slug);
    for (const n of v.partners) if (n.slug) slugsInOrg.add(n.slug);
  }
  const orphanPeople =
    load.kind === "ok"
      ? load.people.filter((p) => !slugsInOrg.has(p.slug))
      : [];

  // Filter + sort state. Both must be declared above the profile
  // early-return so hook order stays stable across the directory ↔
  // profile toggle.
  const searchActive = search.trim().length > 0;
  const searchHits = useMemo(() => {
    if (!searchActive || load.kind !== "ok") return [] as PersonRef[];
    return sortPeople(filterPeople(load.people, search.trim()), sort).slice(0, 30);
  }, [search, searchActive, load, sort]);

  // Profile view short-circuits the tabbed list but leaves tab/loaders
  // intact so hitting Back lands the user exactly where they came from.
  if (profile) {
    return (
      <PersonProfile
        target={profile}
        onOpenDoc={onOpenDoc}
        onBack={onClearProfile}
      />
    );
  }

  const heroSubtitle =
    attention.length === 0
      ? "Direct reports + skip-level reports. No-one needs urgent attention."
      : `${attention.length} need${attention.length === 1 ? "s" : ""} your attention.`;

  return (
    <div className="cos-people">
      <SurfaceHero title="People" subtitle={heroSubtitle} />
      {load.kind === "ok" && load.people.length > 0 && (
        <div className="cos-people-search">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by name…"
            aria-label="Filter people by name"
            className="cos-people-search-input"
          />
          {searchActive && (
            <>
              <label className="cos-people-search-sort">
                <span className="cos-people-search-sort-label">Sort</span>
                <select
                  value={sort}
                  onChange={(e) => setSort(e.target.value as PeopleSort)}
                  aria-label="Sort search results"
                >
                  <option value="last">Most recent</option>
                  <option value="name">Name (A–Z)</option>
                  <option value="staleness">Stalest first</option>
                </select>
              </label>
              <button
                type="button"
                className="cos-btn cos-btn-ghost"
                onClick={() => setSearch("")}
              >
                clear
              </button>
            </>
          )}
        </div>
      )}
      {searchActive && (
        <section className="cos-people-search-results" aria-label="Search results">
          {searchHits.length === 0 ? (
            <p className="cos-empty">No matches.</p>
          ) : (
            <ul className="cos-people-search-list" role="list">
              {searchHits.map((p) => (
                <li key={p.rel_path}>
                  <button
                    type="button"
                    className="cos-people-search-row"
                    onClick={(e) =>
                      onGoToProfile(
                        { slug: p.slug, label: p.label, rel_path: p.rel_path },
                        intentFromEvent(e),
                      )
                    }
                    onAuxClick={(e) => {
                      if (e.button === 1)
                        onGoToProfile(
                          {
                            slug: p.slug,
                            label: p.label,
                            rel_path: p.rel_path,
                          },
                          intentFromEvent(e),
                        );
                    }}
                  >
                    <PersonAvatar
                      photoUrl={p.photo_url}
                      initials={initialsFromLabel(p.label)}
                    />
                    <span className="cos-people-search-text">
                      <span className="cos-people-search-name">{p.label}</span>
                      <span className="cos-people-search-sub">
                        {personSubtitle(p)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {!searchActive && attention.length > 0 && (
        <section className="cos-people-attention" aria-label="Needs your attention">
          <SectionHeader
            label="Needs your attention"
            count={attention.length}
            collapsible
            collapsed={!attentionExpanded}
            onToggle={() => setAttentionExpanded((v) => !v)}
          />
          {attentionExpanded && (
            <div className="cos-people-attention-grid">
              {attention.slice(0, 6).map((p) => (
                <PersonCard
                  key={p.slug}
                  name={p.label}
                  role={attentionRoleLine(p)}
                  initials={initialsFromLabel(p.label)}
                  lastTouched={attentionTouchedLabel(p)}
                  stale={p.reasons.includes("stale")}
                  attention
                  onOpen={(e) =>
                    onGoToProfile(
                      { slug: p.slug, label: p.label, rel_path: p.rel_path },
                      intentFromEvent(e),
                    )
                  }
                />
              ))}
            </div>
          )}
        </section>
      )}

      {!searchActive && orgViews.length > 0 && (
        <div className="cos-tabs" role="tablist">
          {orgViews.map((v) => (
            <button
              key={v.id}
              role="tab"
              aria-selected={tab === v.id}
              className={`cos-tab ${tab === v.id ? "is-active" : ""}`}
              onClick={() => setTab(v.id)}
            >
              {v.label}
            </button>
          ))}
        </div>
      )}

      {orgViews.length === 0 && load.kind === "ok" && (
        <p className="cos-section-lede">
          No org views configured yet — generate one below to get started.
          The generator turns your <code>data/files/areas/one-on-ones/</code>
          folders + Slack/Glean lookups into a structured hierarchy.
        </p>
      )}

      {!searchActive && activeOrgView && (
        <OrgViewPanel
          view={activeOrgView}
          onGoToProfile={(n, e) =>
            onGoToProfile(
              { slug: n.slug ?? n.id, label: n.label, rel_path: n.rel_path! },
              intentFromEvent(e),
            )
          }
        />
      )}

      {orgLoad.kind === "error" && (
        <div className="cos-empty cos-empty-error">
          Could not load org views: {orgLoad.error}
        </div>
      )}

      {!searchActive && orgViews.length > 0 && orphanPeople.length > 0 && (
        <OrphanPanel people={orphanPeople} onGoToProfile={onGoToProfile} />
      )}

      <GeneratorPanel
        orgViewCount={orgViews.length}
        generating={orgRun?.state === "running"}
        error={orgRun?.state === "error" ? orgRun.error ?? null : null}
        onRun={() =>
          runSkill("org-generate", "Generate org views", () =>
            invoke("org_generate"),
          ).catch(() => {
            /* error captured by the run state */
          })
        }
        onDismissError={() => dismissRun("org-generate")}
      />
    </div>
  );
}

function OrphanPanel({
  people,
  onGoToProfile,
}: {
  people: PersonRef[];
  onGoToProfile: (target: ProfileTarget, intent?: OpenIntent) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="cos-orphan-section">
      <button
        type="button"
        className="cos-orphan-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? "▾" : "▸"} {people.length} other{" "}
        {people.length === 1 ? "person" : "people"} with 1:1 folders not yet
        in any org view
      </button>
      {open && (
        <ul className="cos-people-list" role="list">
          {people.map((p) => (
            <PersonRow
              key={p.rel_path}
              person={p}
              onGoToProfile={onGoToProfile}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function GeneratorPanel({
  orgViewCount,
  generating,
  error,
  onRun,
  onDismissError,
}: {
  orgViewCount: number;
  generating: boolean;
  error: string | null;
  onRun: () => void;
  onDismissError: () => void;
}) {
  const label = orgViewCount === 0 ? "Generate org views" : "Regenerate";
  return (
    <div className="cos-org-generator">
      <div className="cos-org-generator-head">
        <h3>{orgViewCount === 0 ? "Build an org view" : "Regenerate"}</h3>
        <button
          type="button"
          className="cos-btn"
          onClick={onRun}
          disabled={generating}
        >
          {generating ? (
            <>
              <span className="cos-newtask-spinner" aria-hidden />
              researching…
            </>
          ) : (
            label
          )}
        </button>
      </div>
      <p className="cos-section-lede">
        Drives the Claude Code CLI with your MCP connectors (Glean, Google
        Workspace, Slack) to research your reporting chain and XFN partners,
        then writes the result to{" "}
        <code>data/files/areas/org/org.json</code>. Typical run: 1–3 minutes.
      </p>
      {generating && (
        <div className="cos-newtask-status" role="status" aria-live="polite">
          Claude is researching via MCPs — this can take a few minutes.
          Don't close the app.
        </div>
      )}
      {error && (
        <div className="cos-newtask-error">
          Generator failed: {error}
          <button
            type="button"
            className="cos-btn cos-btn-ghost"
            onClick={onDismissError}
            style={{ marginLeft: 8 }}
          >
            dismiss
          </button>
        </div>
      )}
    </div>
  );
}


function PersonRow({
  person,
  onGoToProfile,
}: {
  person: PersonRef;
  onGoToProfile: (target: ProfileTarget, intent?: OpenIntent) => void;
}) {
  const staleness = person.last_session
    ? staleLabel(person.last_session)
    : null;

  const open = (e: MouseEvent) =>
    onGoToProfile(
      { slug: person.slug, label: person.label, rel_path: person.rel_path },
      intentFromEvent(e),
    );

  return (
    <li
      className="cos-person-row"
      onClick={open}
      onAuxClick={(e) => {
        if (e.button === 1) open(e);
      }}
    >
      <div className="cos-person-main">
        <span className="cos-person-label">{person.label}</span>
        {!person.has_readme && (
          <span className="cos-chip cos-chip-muted">no README</span>
        )}
      </div>
      <div className="cos-person-meta">
        <span className="cos-person-sessions">
          {person.session_count === 0
            ? "no sessions"
            : person.session_count === 1
              ? "1 session"
              : `${person.session_count} sessions`}
        </span>
        {staleness && (
          <span
            className={`cos-person-staleness ${
              staleness.tone === "stale" ? "cos-person-staleness-stale" : ""
            }`}
            title={person.last_session ?? ""}
          >
            {staleness.label}
          </span>
        )}
      </div>
    </li>
  );
}

/** Search-row avatar — img when person.json has a photo_url, monogram
 *  fallback when not. The monogram matches the PersonCard component
 *  style so the search row reads consistently with the attention grid. */
function PersonAvatar({
  photoUrl,
  initials,
}: {
  photoUrl?: string | null;
  initials: string;
}) {
  if (photoUrl) {
    return (
      <img
        className="cos-people-search-avatar"
        src={photoUrl}
        alt=""
        aria-hidden
        loading="lazy"
        onError={(e) => {
          // If the URL 404s the img stays in the DOM blank; hide it
          // so the search row doesn't render an empty box.
          (e.currentTarget as HTMLImageElement).style.display = "none";
        }}
      />
    );
  }
  return (
    <span className="cos-people-search-avatar cos-people-search-avatar-mono">
      {initials}
    </span>
  );
}

/** Build the search-row subtitle. Title from person.json wins (most
 *  specific); fall back to the relationship folder name converted to
 *  display case ("direct-reports" → "Direct Reports"). */
function personSubtitle(p: PersonRef): string {
  if (p.title && p.title.trim().length > 0) return p.title.trim();
  return p.relationship
    .split("-")
    .map((w) => (w.length === 0 ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(" ");
}

/** Sort modes for the People search results (CP15). Exported so the
 *  sort logic stays testable without spinning up the surface. */
export type PeopleSort = "last" | "name" | "staleness";

export function filterPeople(people: PersonRef[], query: string): PersonRef[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];
  return people.filter(
    (p) =>
      p.label.toLowerCase().includes(q) ||
      p.slug.toLowerCase().includes(q),
  );
}

export function sortPeople(
  people: PersonRef[],
  mode: PeopleSort,
): PersonRef[] {
  const sorted = [...people];
  switch (mode) {
    case "name":
      sorted.sort((a, b) => a.label.localeCompare(b.label));
      break;
    case "staleness":
      // Stalest first: missing last_session pulls to the top (we
      // can't be more stale than "never met"), then oldest dates.
      sorted.sort((a, b) => {
        if (!a.last_session && !b.last_session) {
          return a.label.localeCompare(b.label);
        }
        if (!a.last_session) return -1;
        if (!b.last_session) return 1;
        return a.last_session.localeCompare(b.last_session);
      });
      break;
    case "last":
    default:
      // Most recent session first (the default — useful when
      // searching for "who did I just talk to").
      sorted.sort((a, b) => {
        if (!a.last_session && !b.last_session) {
          return a.label.localeCompare(b.label);
        }
        if (!a.last_session) return 1;
        if (!b.last_session) return -1;
        return b.last_session.localeCompare(a.last_session);
      });
      break;
  }
  return sorted;
}

function initialsFromLabel(label: string): string {
  const parts = label.trim().split(/\s+/);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0] + parts[parts.length - 1]![0]).toUpperCase();
}

function attentionRoleLine(p: AttentionPerson): string {
  const rel = p.relationship
    .split("-")
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");
  return rel;
}

function attentionTouchedLabel(p: AttentionPerson): string {
  if (p.reasons.includes("no-sessions")) return "No sessions";
  if (p.reasons.includes("no-readme")) return "No README";
  if (p.days_since_last_session == null) return "—";
  const d = p.days_since_last_session;
  if (d === 0) return "today";
  if (d === 1) return "1d";
  if (d < 14) return `${d}d`;
  if (d < 60) return `${Math.round(d / 7)}w`;
  return `${Math.round(d / 30)}mo`;
}

function staleLabel(
  date: string,
): { label: string; tone: "fresh" | "stale" } {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return { label: date, tone: "fresh" };
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const target = new Date(d);
  target.setHours(0, 0, 0, 0);
  const days = Math.round((now.getTime() - target.getTime()) / 86_400_000);
  if (days <= 0) return { label: "today", tone: "fresh" };
  if (days === 1) return { label: "yesterday", tone: "fresh" };
  if (days < 14) return { label: `${days}d ago`, tone: "fresh" };
  if (days < 60) return { label: `${Math.round(days / 7)}w ago`, tone: "stale" };
  return { label: `${Math.round(days / 30)}mo ago`, tone: "stale" };
}
