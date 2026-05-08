import { useEffect, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Clock, PanelLeftClose, PanelLeft, Pin, PinOff } from "lucide-react";

import {
  getUnseenCount,
  getVersion,
  subscribeChat,
} from "../state/chatSession";
import {
  DEVELOPER_SURFACES_CHANGED_EVENT,
  readShowDeveloperSurfaces,
} from "../state/developerSurfaces";
import { type OpenDoc } from "../state/openDoc";
import {
  RECENT_CHANGED_EVENT,
  decorateRecentLabel,
  readRecent,
  readSidebarRecentsMax,
  togglePinned,
  type RecentDoc,
} from "../state/recentDocs";
import { SURFACES, type SurfaceId } from "../state/surfaces";

type SidebarBadges = {
  overdueTasks: number;
  pendingAnnotations: number;
  /** PRs awaiting the user's review. B8-CP31 — surfaces alongside
   *  overdueTasks on the Work entry. */
  reviewRequests: number;
  /** Active SEV-1 / SEV-2 incidents from the last /ops-incidents
   *  snapshot. B8-CP31 — surfaces on the Ops entry. */
  activeIncidents: number;
  /** PRD-116 §4.3.1 — count of Console tabs that finished an
   *  in-flight turn while the user was on a different surface or
   *  tab. Cleared per-tab when the user switches to that tab. */
  consoleUnseen: number;
};

/** Pure: derive the badge count for a given surface. Exported for
 *  unit tests so the surface-id ↔ source-of-truth mapping stays
 *  pinned. */
export function badgeForSurface(
  surface: SurfaceId,
  badges: SidebarBadges,
): number {
  if (surface === "work") {
    // Sum of overdues + review requests so a single number on the
    // Work entry covers both classes of "needs your attention". The
    // tooltip in the surface itself disambiguates.
    return badges.overdueTasks + badges.reviewRequests;
  }
  if (surface === "home") return badges.pendingAnnotations;
  if (surface === "ops") return badges.activeIncidents;
  if (surface === "console") return badges.consoleUnseen;
  return 0;
}

type Props = {
  active: SurfaceId;
  collapsed: boolean;
  /**
   * Switch surface. The optional event is forwarded so Shell can
   * resolve PRD-v2-117 click-modifier intent (Cmd-click → new
   * background tab, Cmd+Shift-click → new foreground tab,
   * middle-click → background). Plain click leaves it `undefined` and
   * Shell falls back to "current".
   */
  onSelect: (
    id: SurfaceId,
    e?: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; button?: number },
  ) => void;
  onToggle: () => void;
  /** Open a recent doc when the user clicks a row in the recents
   *  section. Threaded through Shell so the doc opens in the same
   *  editor instance the rest of the app uses. */
  onOpenDoc: (
    doc: OpenDoc,
    e?: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; button?: number },
  ) => void;
};

export function Sidebar({
  active,
  collapsed,
  onSelect,
  onToggle,
  onOpenDoc,
}: Props) {
  const [recents, setRecents] = useState<RecentDoc[]>(() =>
    readRecent().slice(0, readSidebarRecentsMax()),
  );
  const [badges, setBadges] = useState<SidebarBadges>({
    overdueTasks: 0,
    pendingAnnotations: 0,
    reviewRequests: 0,
    activeIncidents: 0,
    consoleUnseen: 0,
  });
  // Live-track the Console unseen-completions count so the sidebar
  // pip ticks up the moment a backgrounded tab finishes a turn. The
  // chat-session store emits on every mutation; we re-read the
  // count on each tick.
  useSyncExternalStore(subscribeChat, getVersion, getVersion);
  const consoleUnseen = getUnseenCount();
  useEffect(() => {
    setBadges((b) =>
      b.consoleUnseen === consoleUnseen ? b : { ...b, consoleUnseen },
    );
  }, [consoleUnseen]);
  // PRD-116 — surfaces flagged `developer: true` (currently just
  // Console) hide unless the user opted in. Live-update on the
  // toggle event so a flip in Settings doesn't need a reload.
  const [showDeveloperSurfaces, setShowDeveloperSurfaces] = useState<boolean>(
    () => readShowDeveloperSurfaces(),
  );
  useEffect(() => {
    const onChange = () => setShowDeveloperSurfaces(readShowDeveloperSurfaces());
    window.addEventListener(DEVELOPER_SURFACES_CHANGED_EVENT, onChange);
    return () =>
      window.removeEventListener(DEVELOPER_SURFACES_CHANGED_EVENT, onChange);
  }, []);
  // Always show a developer surface when it's the active one, even if
  // the toggle is off (matches the PRD's "deep-linking reveals a
  // hidden surface" pattern). The user has clearly *gotten* there.
  const visibleSurfaces = SURFACES.filter(
    (s) => !s.developer || showDeveloperSurfaces || s.id === active,
  );

  // Subscribe to the recents-changed event so the section live-updates
  // when the user opens a doc anywhere else (palette, Home, profile)
  // OR flips the sidebar-recents-max dropdown in Settings.
  useEffect(() => {
    const onChange = () =>
      setRecents(readRecent().slice(0, readSidebarRecentsMax()));
    window.addEventListener(RECENT_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(RECENT_CHANGED_EVENT, onChange);
  }, []);

  // Sidebar badges (B7-CP26) — overdue task count next to Tasks,
  // pending-annotation count next to Home. Refreshes on a 60s timer
  // so they don't go stale during a long session, plus on the
  // recents-changed event as a cheap proxy for "user did
  // something". Each probe is best-effort: a failure leaves the
  // badge at 0 rather than throwing.
  useEffect(() => {
    let cancelled = false;
    const today = (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    })();
    const refresh = async () => {
      let overdue = 0;
      let pending = 0;
      let reviews = 0;
      let incidents = 0;
      try {
        type Task = { due: string | null };
        const tasks = await invoke<Task[]>("v1_tasks_list");
        for (const t of tasks) {
          if (t.due && t.due.slice(0, 10) < today) overdue++;
        }
      } catch {
        // ignore
      }
      try {
        type Pending = { pending_count: number };
        const docs = await invoke<Pending[]>("annotations_list_pending");
        for (const d of docs) pending += d.pending_count;
      } catch {
        // ignore
      }
      // B8-CP31 — review-requested PRs. Failure leaves the badge at
      // 0; gh missing or unauth shouldn't render a misleading "0
      // reviews" warning.
      try {
        type Pr = { url: string };
        const rows = await invoke<Pr[]>("gh_review_requests", { limit: 50 });
        reviews = rows.length;
      } catch {
        // ignore
      }
      // B8-CP31 — SEV-1/SEV-2 active incidents from the last
      // snapshot. We do not invoke the skill from the sidebar.
      try {
        type IncidentsPayload = {
          incidents: { severity?: string }[];
        };
        const v = await invoke<IncidentsPayload>("ops_incidents_read");
        incidents = (v.incidents ?? []).filter((i) => {
          const s = (i.severity ?? "").toUpperCase();
          return s === "SEV-1" || s === "SEV-2";
        }).length;
      } catch {
        // ignore
      }
      if (!cancelled) {
        // Preserve `consoleUnseen` — that field is driven by the
        // chat-session store, not by these probes.
        setBadges((prev) => ({
          ...prev,
          overdueTasks: overdue,
          pendingAnnotations: pending,
          reviewRequests: reviews,
          activeIncidents: incidents,
        }));
      }
    };
    refresh();
    const handle = window.setInterval(refresh, 60_000);
    const onActivity = () => refresh();
    window.addEventListener(RECENT_CHANGED_EVENT, onActivity);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
      window.removeEventListener(RECENT_CHANGED_EVENT, onActivity);
    };
  }, []);

  return (
    <nav
      className={`cos-sidebar ${collapsed ? "is-collapsed" : ""}`}
      aria-label="Primary"
    >
      <div className="cos-sidebar-brand">
        <span className="cos-dot" aria-hidden />
        {!collapsed && <span className="cos-sidebar-title">Chief of Staff</span>}
      </div>

      <ul className="cos-sidebar-list">
        {visibleSurfaces.map((s) => {
          const Icon = s.icon;
          const isActive = s.id === active;
          const badge = badgeForSurface(s.id, badges);
          return (
            <li key={s.id}>
              <button
                type="button"
                className={`cos-sidebar-item ${isActive ? "is-active" : ""}`}
                aria-current={isActive ? "page" : undefined}
                onClick={(e) => onSelect(s.id, e)}
                onAuxClick={(e) => {
                  // Middle-click → open in new background tab.
                  if (e.button === 1) onSelect(s.id, e);
                }}
                title={
                  collapsed
                    ? badge > 0
                      ? `${s.label} · ⌘⌥${s.index} · ${badge}`
                      : `${s.label} · ⌘⌥${s.index}`
                    : undefined
                }
              >
                <Icon size={18} strokeWidth={1.75} aria-hidden />
                {!collapsed ? (
                  <>
                    <span className="cos-sidebar-label">{s.label}</span>
                    <span className="cos-sidebar-trailing">
                      {badge > 0 && (
                        <span
                          className="cos-sidebar-badge"
                          aria-label={`${badge}`}
                        >
                          {badge > 99 ? "99+" : badge}
                        </span>
                      )}
                      <span className="cos-sidebar-shortcut">⌘⌥{s.index}</span>
                    </span>
                  </>
                ) : (
                  badge > 0 && (
                    <span
                      className="cos-sidebar-badge cos-sidebar-badge-collapsed"
                      aria-hidden
                    />
                  )
                )}
              </button>
            </li>
          );
        })}
      </ul>

      {!collapsed && recents.length > 0 && (
        <div className="cos-sidebar-recents" aria-label="Recent documents">
          <h3 className="cos-sidebar-section-head">Recent</h3>
          <ul className="cos-sidebar-recents-list">
            {recents.map((r) => (
              <li key={r.relPath} className="cos-sidebar-recent-item">
                <button
                  type="button"
                  className="cos-sidebar-recent"
                  onClick={(e) =>
                    onOpenDoc({ relPath: r.relPath, label: r.label }, e)
                  }
                  onAuxClick={(e) => {
                    if (e.button === 1)
                      onOpenDoc({ relPath: r.relPath, label: r.label }, e);
                  }}
                  title={r.relPath}
                >
                  {r.pinned ? (
                    <Pin
                      size={12}
                      strokeWidth={1.75}
                      aria-hidden
                      className="cos-sidebar-recent-pinned"
                    />
                  ) : (
                    <Clock size={12} strokeWidth={1.75} aria-hidden />
                  )}
                  <span className="cos-sidebar-recent-label">
                    {decorateRecentLabel(r.relPath, r.label)}
                  </span>
                </button>
                <button
                  type="button"
                  className="cos-sidebar-recent-pin"
                  onClick={(e) => {
                    e.stopPropagation();
                    togglePinned(r.relPath);
                  }}
                  aria-label={r.pinned ? "Unpin" : "Pin"}
                  title={r.pinned ? "Unpin from recents" : "Pin to recents"}
                >
                  {r.pinned ? (
                    <PinOff size={12} strokeWidth={1.75} aria-hidden />
                  ) : (
                    <Pin size={12} strokeWidth={1.75} aria-hidden />
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {collapsed && recents.length > 0 && (
        // Subtle indicator that recents exist while the sidebar is in
        // icons-only mode. Tooltip lists the topmost rel-path so the
        // user has a one-glance reminder of "I was just in <foo>".
        <div
          className="cos-sidebar-recent-indicator"
          aria-hidden
          title={`${recents.length} recent — top: ${
            recents[0]
              ? decorateRecentLabel(recents[0].relPath, recents[0].label)
              : ""
          }`}
        >
          <Clock size={12} strokeWidth={1.75} aria-hidden />
        </div>
      )}

      <button
        type="button"
        className="cos-sidebar-toggle"
        onClick={onToggle}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        title={collapsed ? "Expand sidebar · ⌘⇧B" : "Collapse sidebar · ⌘⇧B"}
      >
        {collapsed ? (
          <PanelLeft size={16} strokeWidth={1.75} aria-hidden />
        ) : (
          <PanelLeftClose size={16} strokeWidth={1.75} aria-hidden />
        )}
      </button>
    </nav>
  );
}
