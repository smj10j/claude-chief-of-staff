import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import {
  decorateRecentLabel,
  readRecent,
  type RecentDoc,
} from "../state/recentDocs";
import { deriveTitle, type TabState } from "../state/tabs";
import {
  buildEntries,
  rank,
  type PaletteContext,
  type PaletteEntry,
} from "./ranking";
import "./palette.css";

type SearchHit = {
  rel_path: string;
  label: string;
  context: string;
  snippet: string;
  hits: number;
};

type TaskRow = {
  id: string;
  title: string;
  priority: string;
  due: string | null;
  status: string;
  tags: string[];
};

type PersonRef = {
  slug: string;
  label: string;
  relationship: string;
  rel_path: string;
};

type MeetingRef = {
  slug: string;
  label: string;
  rel_path: string;
};

type ProjectRef = {
  slug: string;
  label: string;
  rel_path: string;
};

type Props = {
  open: boolean;
  recent: readonly string[];
  context: PaletteContext;
  /** PRD-v2-117 §4.9 / criterion #15: the open tab strip is exposed
   *  to the palette so it can surface an "Open tabs" section and
   *  decorate doc results that match an already-open target. */
  openTabs: readonly TabState[];
  onDismiss: () => void;
  onRan: (id: string) => void;
};

export function CommandPalette({
  open,
  recent,
  context,
  openTabs,
  onDismiss,
  onRan,
}: Props) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [docHits, setDocHits] = useState<PaletteEntry[]>([]);
  const [recentEntries, setRecentEntries] = useState<PaletteEntry[]>([]);
  const [taskEntries, setTaskEntries] = useState<PaletteEntry[]>([]);
  const [entityEntries, setEntityEntries] = useState<PaletteEntry[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const baseEntries = useMemo(() => buildEntries(context), [context]);

  // PRD-v2-117 §4.9 / criterion #15: "Open tabs" entries, ranked by
  // recency (lastActiveAt desc). A `tab:` prefix scopes the query to
  // open tabs only.
  const tabEntries = useMemo<PaletteEntry[]>(() => {
    const sorted = [...openTabs].sort(
      (a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt),
    );
    return sorted.map((t) => {
      // 1-based slot index used in the "Tab N" chip — the Cmd+1..9
      // shortcut maps the strip's *positional* order, so use the
      // current openTabs index, not the recency-sorted index.
      const positional = openTabs.findIndex((x) => x.id === t.id) + 1;
      return {
        id: `tab:${t.id}`,
        kind: "tab" as const,
        label: deriveTitle(t),
        hint: "open tab",
        tabIndex: positional,
        run: (ctx) => ctx.switchToTab(t.id),
      };
    });
  }, [openTabs]);

  // Identify doc-match results that point at a target also open in
  // a tab, then decorate the matching tab entry with the doc's
  // "Tab N" chip so it sorts above the "open this in current tab"
  // path. PRD §4.9 / criterion #15.
  const tabDocHits = useMemo<PaletteEntry[]>(() => {
    if (openTabs.length === 0 || docHits.length === 0) return [];
    const out: PaletteEntry[] = [];
    for (const hit of docHits) {
      const relPath = hit.id.replace(/^doc:/, "");
      const idx = openTabs.findIndex(
        (t) => t.openDoc?.relPath === relPath,
      );
      if (idx < 0) continue;
      const t = openTabs[idx]!;
      out.push({
        id: `tab-doc:${t.id}`,
        kind: "tab",
        label: hit.label,
        hint: "switch to open tab",
        tabIndex: idx + 1,
        // Sort tightly above the open-this-doc-here action.
        searchScore: (hit.searchScore ?? 80) + 5,
        run: (ctx) => ctx.switchToTab(t.id),
      });
    }
    return out;
  }, [docHits, openTabs]);

  // Recent docs surface only on the empty-query path; once the user starts
  // typing, content_search drives the doc list and entity entries (people,
  // meetings, projects) join the active-query pool so a name match jumps
  // straight to the right profile/detail.
  const trimmed = query.trim();
  // `tab:` prefix scopes the palette to open tabs only.
  const tabFilterMode = trimmed.toLowerCase().startsWith("tab:");
  const entries = useMemo(
    () => {
      if (tabFilterMode) {
        return tabEntries;
      }
      if (trimmed.length === 0) {
        return [...tabEntries, ...baseEntries, ...recentEntries];
      }
      return [
        ...baseEntries,
        ...taskEntries,
        ...entityEntries,
        ...tabDocHits,
        ...docHits,
      ];
    },
    [
      baseEntries,
      taskEntries,
      entityEntries,
      docHits,
      tabDocHits,
      recentEntries,
      tabEntries,
      tabFilterMode,
      trimmed,
    ],
  );

  // Snapshot recently-opened docs when the palette opens so the empty-query
  // path can surface them. Cap to 5 — the palette overflow is its own bug.
  useEffect(() => {
    if (!open) return;
    const recents: RecentDoc[] = readRecent().slice(0, 5);
    setRecentEntries(
      recents.map((r): PaletteEntry => ({
        id: `doc:${r.relPath}`,
        kind: "doc",
        label: decorateRecentLabel(r.relPath, r.label),
        hint: "recent",
        // Pass the original label through to handleOpenDoc so the
        // editor breadcrumb stays the original "README" / date — only
        // the palette row gets the decorated form.
        run: () => context.openDoc(r.relPath, r.label),
      })),
    );
  }, [open, context]);

  // Snapshot people / meetings / projects when the palette opens. These
  // entity rows only show on active queries (substring match against the
  // label) — surfacing 30+ people on an empty palette would be too noisy.
  // The lists are small + cheap to enumerate; one round-trip per open is
  // fine, no debouncing needed.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const [people, meetings, projects] = await Promise.all([
          invoke<PersonRef[]>("content_list_people").catch(
            () => [] as PersonRef[],
          ),
          invoke<MeetingRef[]>("content_list_meetings").catch(
            () => [] as MeetingRef[],
          ),
          invoke<ProjectRef[]>("content_list_project_refs").catch(
            () => [] as ProjectRef[],
          ),
        ]);
        if (cancelled) return;
        const next: PaletteEntry[] = [];
        for (const p of people) {
          next.push({
            id: `person:${p.slug}`,
            kind: "person",
            label: p.label,
            hint: p.relationship.replace(/-/g, " "),
            run: () =>
              context.goToProfile({
                slug: p.slug,
                label: p.label,
                rel_path: p.rel_path,
              }),
          });
        }
        for (const m of meetings) {
          next.push({
            id: `meeting:${m.slug}`,
            kind: "meeting",
            label: m.label,
            hint: "recurring meeting",
            run: () =>
              context.goToMeeting({
                slug: m.slug,
                label: m.label,
                rel_path: m.rel_path,
              }),
          });
        }
        for (const p of projects) {
          next.push({
            id: `project:${p.slug}`,
            kind: "project",
            label: p.label,
            hint: "project",
            run: () =>
              context.goToProject({
                slug: p.slug,
                label: p.label,
                rel_path: p.rel_path,
              }),
          });
        }
        setEntityEntries(next);
      } catch {
        if (!cancelled) setEntityEntries([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, context]);

  // Snapshot the active v1 task list when the palette opens. The list
  // is small (active tasks only — completed/archived already filtered
  // by the IPC), so client-side substring matching via the existing
  // ranker is faster than a per-keystroke backend round-trip.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const tasks = await invoke<TaskRow[]>("v1_tasks_list");
        if (cancelled) return;
        setTaskEntries(
          tasks.map((t): PaletteEntry => {
            const dueHint = t.due ? `· due ${t.due}` : "";
            const prioHint =
              t.priority && t.priority !== "medium"
                ? `· ${t.priority}`
                : "";
            return {
              id: `task:${t.id}`,
              kind: "task",
              label: t.title,
              hint: [dueHint, prioHint].filter(Boolean).join(" ").trim() ||
                undefined,
              run: () => context.goToTask(t.id),
            };
          }),
        );
      } catch {
        if (!cancelled) setTaskEntries([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, context]);
  const results = useMemo(() => {
    // `tab:` prefix scopes the query to open tabs and strips the
    // prefix before ranking so "tab: alice" matches the Alice tab.
    if (tabFilterMode) {
      const stripped = trimmed.replace(/^tab:\s*/i, "");
      return rank(entries, stripped, recent);
    }
    return rank(entries, query, recent);
  }, [entries, query, recent, tabFilterMode, trimmed]);

  // Debounced content search. Only fires for queries ≥ 2 chars to avoid
  // walking the content tree on every keystroke. The 250 ms window
  // matches the user's typing cadence — long enough to coalesce a
  // word-typing burst, short enough that pause-and-look feels live.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setDocHits([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const hits = await invoke<SearchHit[]>("content_search", {
          query: q,
          limit: 12,
        });
        if (cancelled) return;
        setDocHits(
          hits.map((h, i): PaletteEntry => ({
            id: `doc:${h.rel_path}`,
            kind: "doc",
            // Decorate with the owner segment so generic labels
            // ("README", "2026-04-22") read as "Alice · 2026-04-22"
            // — matches the tab title and Recent section treatment.
            label: decorateRecentLabel(h.rel_path, h.label),
            hint: h.context
              ? `${h.context} · ${h.snippet}`
              : h.snippet,
            // Score: at most 80 (below view/command exact-prefix at 90),
            // decreasing by hit count so the most-mentioned doc lands
            // first when scores tie.
            searchScore: 80 - Math.min(20, i) - (h.hits === 0 ? 5 : 0),
            // Pass the original label through to openDoc so the
            // editor breadcrumb / openDoc.label stay the original
            // form; only the palette row label is decorated.
            run: () =>
              context.openDoc(h.rel_path, h.label),
          })),
        );
      } catch {
        if (!cancelled) setDocHits([]);
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, context]);

  // Reset + focus when opened.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setCursor(0);
    const id = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  // Keep cursor in bounds as results change.
  useEffect(() => {
    if (cursor >= results.length) setCursor(Math.max(0, results.length - 1));
  }, [results.length, cursor]);

  if (!open) return null;

  function select(entry: PaletteEntry) {
    entry.run(context);
    onRan(entry.id);
    onDismiss();
  }

  function onKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(results.length - 1, c + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const picked = results[cursor];
      if (picked) select(picked.entry);
    } else if (e.key === "Escape") {
      // Stop propagation so the window-level Escape handler doesn't also
      // fire and close whatever overlay is underneath the palette.
      e.preventDefault();
      e.stopPropagation();
      onDismiss();
    }
  }

  return (
    <div
      className="cos-palette-scrim"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onKeyDown={onKey}
      onClick={(e) => {
        if (e.target === e.currentTarget) onDismiss();
      }}
    >
      <div className="cos-palette">
        <input
          ref={inputRef}
          className="cos-palette-input"
          placeholder="Jump to a surface, run a command…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          aria-autocomplete="list"
          aria-controls="cos-palette-results"
        />
        <ul
          className="cos-palette-results"
          id="cos-palette-results"
          role="listbox"
        >
          {results.length === 0 && (
            <li className="cos-palette-empty">No matches.</li>
          )}
          {results.map(({ entry }, i) => (
            <li
              key={entry.id}
              role="option"
              aria-selected={i === cursor}
              className={`cos-palette-row ${i === cursor ? "is-active" : ""}`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => select(entry)}
            >
              <span className="cos-palette-kind">{entry.kind}</span>
              <span className="cos-palette-label">{entry.label}</span>
              {entry.tabIndex !== undefined && (
                <span className="cos-palette-tab-chip">
                  Tab {entry.tabIndex}
                </span>
              )}
              {entry.hint && (
                <span className="cos-palette-hint">{entry.hint}</span>
              )}
              {entry.shortcut && (
                <span className="cos-palette-shortcut">{entry.shortcut}</span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
