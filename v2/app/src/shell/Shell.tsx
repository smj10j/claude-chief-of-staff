import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { invoke } from "@tauri-apps/api/core";

import { inferDocContext } from "../state/docContext";

// Tiptap + its extensions are the largest single chunk in the bundle.
// Lazy-loading them here keeps the cold-start to Home/People/etc.
// snappy; the editor chunk fetches the first time the user opens a doc.
const DocEditor = lazy(() =>
  import("../editor/DocEditor").then((m) => ({ default: m.DocEditor })),
);
// HTML editor (CodeMirror + sandboxed iframe preview) — only fetched
// when the user opens an .html file. Markdown docs never pay this cost.
const HtmlEditor = lazy(() =>
  import("../editor/HtmlEditor").then((m) => ({ default: m.HtmlEditor })),
);
import { CommandPalette } from "../palette/CommandPalette";
import { useGlobalKeys } from "../state/keys";
import { type OpenDoc } from "../state/openDoc";
import { mark } from "../state/perf";
import { recordRecent } from "../state/recentDocs";
import { type SurfaceId } from "../state/surfaces";
import {
  activeTab as readActiveTab,
  appendTab,
  canGoBack as readCanGoBack,
  canGoForward as readCanGoForward,
  closeOtherTabs as closeOtherTabsInState,
  closeTab as closeTabInState,
  closeTabsToTheRight as closeTabsToTheRightInState,
  createTab,
  duplicateTab as duplicateTabInState,
  goBack as goBackInState,
  goForward as goForwardInState,
  initialTabsState,
  intentFromEvent,
  moveTab as moveTabInState,
  nextTab as nextTabInState,
  pinTab as pinTabInState,
  prevTab as prevTabInState,
  renameTab as renameTabInState,
  reopenLastClosedTab,
  switchTab as switchTabInState,
  switchToTabByIndex,
  unpinTab as unpinTabInState,
  updateActiveTab,
  type OpenIntent,
  type TabState,
  type TabsState,
} from "../state/tabs";
import {
  pruneOldDiagnostics,
  readPersistedTabs,
  restoreOnLaunch,
  snapshotForCrashRecovery,
  writePersistedTabs,
} from "../state/tabsPersistence";
import { showToast } from "../state/toasts";
import { type MeetingTarget } from "../surfaces/MeetingDetail";
import { type ProfileTarget } from "../surfaces/PersonProfile";
import { type ProjectTarget } from "../surfaces/ProjectDetail";
import { type V1Task } from "../surfaces/Work";
import { Catalog } from "../ui/Catalog";
import { Header } from "./Header";
import {
  InstallWizard,
  shouldShowFirstRun,
} from "./InstallWizard";
import { ErrorBoundary } from "./ErrorBoundary";
import { QuickCapture } from "./QuickCapture";
import { ResizeHandle } from "./ResizeHandle";
import { ShortcutsModal } from "./ShortcutsModal";
import { CrashRecoveryPrompt } from "./CrashRecoveryPrompt";
import { Sidebar } from "./Sidebar";
import { SurfaceRouter, SurfaceSidePanel } from "./SurfaceRouter";
import { TabStrip, TABPANEL_ID, type TabStripHandle } from "./TabStrip";
import { ToastHost } from "./ToastHost";
import { UpdateBanner } from "./UpdateBanner";
import { checkForUpdate, readAutoInstall } from "../state/updater";

const LAYOUT_WIDTH_KEY = "cos.layout-widths.v1";
const SIDEBAR_WIDTH_DEFAULT = 220;
const SIDEBAR_WIDTH_MIN = 160;
const SIDEBAR_WIDTH_MAX = 400;
// 440 default fits the task detail's snooze chips + Due chip + relative-time
// chip on one row at the smallest reasonable density. 380 was too tight after
// B7-CP9/CP11 added the chip rows.
const SIDE_PANEL_WIDTH_DEFAULT = 440;
const SIDE_PANEL_WIDTH_MIN = 280;
const SIDE_PANEL_WIDTH_MAX = 700;

function readStoredLayoutWidths(): {
  sidebar?: number;
  side?: number;
} {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(LAYOUT_WIDTH_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { sidebar?: unknown; side?: unknown };
    return {
      sidebar:
        typeof parsed.sidebar === "number" ? parsed.sidebar : undefined,
      side: typeof parsed.side === "number" ? parsed.side : undefined,
    };
  } catch {
    return {};
  }
}

const RECENT_MAX = 8;

export function Shell() {
  // PRD-v2-117 Stage 1 — eight previously-Shell-local fields (active
  // surface, openDoc, peopleProfile/projectProfile/meetingProfile,
  // selectedTask, sideOpen, taskScrollHint) move into a per-tab
  // TabState record. Stage 3 wires persistence: we hydrate from
  // localStorage on mount, debounce writes, and flush on quit.
  //
  // The initial state is always a single Home tab. Hydration from a
  // persisted clean-quit blob happens in the effect below — keeping
  // the synchronous initializer fast (PRD §4.10 hydration cap).
  // The crash-recovery prompt branch reads the blob *without*
  // restoring; the user picks restore or start-fresh from the sheet.
  const [tabsState, setTabsState] = useState<TabsState>(() =>
    initialTabsState(),
  );
  const [pendingRestore, setPendingRestore] = useState<TabsState | null>(null);
  const [persistRejected, setPersistRejected] = useState(false);
  const tabStripRef = useRef<TabStripHandle | null>(null);
  const tab = readActiveTab(tabsState);
  const active = tab.surface;
  const openDoc = tab.openDoc;
  const peopleProfile = tab.peopleProfile;
  const projectProfile = tab.projectProfile;
  const meetingProfile = tab.meetingProfile;
  const selectedTask = tab.selectedTask;
  const sideOpen = tab.sideOpen;
  const taskScrollHint = tab.taskScrollHint;

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [quickCaptureOpen, setQuickCaptureOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // First-run check. Render the wizard once when the storage flag
  // hasn't been set. The wizard itself sets the flag on dismiss so
  // we don't show again. Settings → Diagnostics has a "rerun setup"
  // affordance for triggering it manually.
  useEffect(() => {
    let cancelled = false;
    if (shouldShowFirstRun()) {
      // Probe install_status — if everything's already OK, mark the
      // wizard complete silently so we don't pester returning users
      // who set things up via CLI.
      invoke<{ all_ok: boolean }>("install_status")
        .then((s) => {
          if (cancelled) return;
          if (s.all_ok) {
            // Set the flag without showing the wizard.
            try {
              window.localStorage.setItem(
                "cos.first-run-complete.v1",
                "true",
              );
            } catch {
              /* private mode */
            }
          } else {
            setWizardOpen(true);
          }
        })
        .catch(() => {
          // If install_status itself fails, show the wizard so the
          // user can at least see the diagnostic copy.
          if (!cancelled) setWizardOpen(true);
        });
    }
    // Manual re-trigger from Settings → Diagnostics.
    function onReopen() {
      setWizardOpen(true);
    }
    window.addEventListener("cos:open-install-wizard", onReopen);
    return () => {
      cancelled = true;
      window.removeEventListener("cos:open-install-wizard", onReopen);
    };
  }, []);
  const [recent, setRecent] = useState<string[]>([]);
  const [taskRefreshNonce, setTaskRefreshNonce] = useState(0);
  // The eight Shell-local fields above (selectedTask, taskScrollHint,
  // openDoc, peopleProfile, projectProfile, meetingProfile, sideOpen,
  // active) are now derived from the active tab's TabState. Setters
  // route through `mutateActive` below.
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const stored = readStoredLayoutWidths().sidebar;
    return Math.max(
      SIDEBAR_WIDTH_MIN,
      Math.min(SIDEBAR_WIDTH_MAX, stored ?? SIDEBAR_WIDTH_DEFAULT),
    );
  });
  const [sidePanelWidth, setSidePanelWidth] = useState<number>(() => {
    const stored = readStoredLayoutWidths().side;
    return Math.max(
      SIDE_PANEL_WIDTH_MIN,
      Math.min(SIDE_PANEL_WIDTH_MAX, stored ?? SIDE_PANEL_WIDTH_DEFAULT),
    );
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        LAYOUT_WIDTH_KEY,
        JSON.stringify({ sidebar: sidebarWidth, side: sidePanelWidth }),
      );
    } catch {
      /* private mode — drag adjustments are session-only */
    }
  }, [sidebarWidth, sidePanelWidth]);

  // PRD-v2-117 §4.5 — hydrate the persisted tab strip on mount.
  //
  //   - clean quit + restore-on-launch toggle on  → restore directly
  //   - clean quit + restore-on-launch toggle off → seed Home,
  //     persisted blob stays put for a future flip
  //   - unclean quit                              → show prompt;
  //     user chooses Restore or Start with Home
  //   - corrupt / future-version blob             → recovered to
  //     Home; the broken blob lives in quarantine for diagnostics
  //
  // Runs once. The empty deps are intentional — re-hydrating on
  // re-render would clobber any state the user has built up since.
  useEffect(() => {
    const r = readPersistedTabs();
    if (r.kind === "absent") return;
    if (r.kind === "recovered") return; // blob is bad; we already
                                        // initialized Home, so just
                                        // leave the user there.
    if (r.kind === "missing-active-tab") {
      // The repaired state still represents the user's prior tabs;
      // treat it like a clean restore.
      if (restoreOnLaunch()) setTabsState(r.state);
      return;
    }
    // r.kind === "ok"
    if (!restoreOnLaunch()) return;
    if (r.cleanQuit) {
      setTabsState(r.state);
    } else {
      // Stash the candidate; the user picks restore or fresh.
      setPendingRestore(r.state);
    }
    // Mark cleanQuit=false on the persisted blob now — this app
    // session is only "clean" if the before-quit hook fires later.
    writePersistedTabs(r.state, { cleanQuit: false });
  }, []);

  // PRD-103 Phase 1B — silent update check on app startup. Fires
  // a few seconds after first paint so it doesn't compete with
  // editor mount or Home's initial fetches. Silent variant: a
  // no-update-found result leaves state at idle (no "you're up to
  // date" banner for the auto-check). Settings → Updates surfaces
  // the same call non-silently for a manual "Check now."
  useEffect(() => {
    if (!readAutoInstall()) return;
    const id = window.setTimeout(() => {
      void checkForUpdate({ silent: true });
    }, 5000);
    return () => window.clearTimeout(id);
  }, []);

  // PRD-115 §7.5 — dev-only Catalog accessible at #/catalog. No nav, no shell.
  const [catalogMode, setCatalogMode] = useState(
    () => typeof window !== "undefined" && window.location.hash === "#/catalog",
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onHashChange = () => {
      setCatalogMode(window.location.hash === "#/catalog");
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Single mutator funnel — every navigation that used to call N
  // separate setters now patches the active tab in one go. Keeps the
  // active TabState coherent (no torn state across React batches).
  const mutateActive = useCallback(
    (patch: (t: TabsState["tabs"][number]) => Partial<TabsState["tabs"][number]>) => {
      setTabsState((s) => updateActiveTab(s, patch));
    },
    [],
  );

  /**
   * Apply an open intent to a TabState patch. PRD §4.4.3 click
   * modifiers funnel through here:
   *   - "current": mutate the active tab in place (today's behavior)
   *   - "new-bg":  create a new tab seeded with `patch`, do not focus
   *   - "new-fg":  create a new tab seeded with `patch`, focus it
   *
   * The new tab inherits its surface from the patch; if `patch.surface`
   * is undefined, we fall back to the *current* tab's surface so a
   * Cmd-click on a sidebar Recent doc opens a new tab parked on the
   * doc's host surface, not Home.
   */
  const openWithIntent = useCallback(
    (intent: OpenIntent, patch: Partial<TabState>) => {
      if (intent === "current") {
        mutateActive(() => patch);
        return;
      }
      setTabsState((s) => {
        const fallbackSurface = readActiveTab(s).surface;
        const newTab = createTab(patch.surface ?? fallbackSurface, patch);
        return appendTab(s, newTab, intent === "new-fg");
      });
    },
    [mutateActive],
  );

  // ---- Tab strip handlers (PRD §4.4.1 / §4.4.3) ----
  const handleNewTab = useCallback(() => {
    setTabsState((s) => {
      const newTab = createTab("home");
      return appendTab(s, newTab, true);
    });
  }, []);

  const handleCloseActiveTab = useCallback(() => {
    setTabsState((s) => closeTabInState(s, s.activeTabId));
  }, []);

  const handleCloseTab = useCallback((tabId: string) => {
    setTabsState((s) => closeTabInState(s, tabId));
  }, []);

  const handleSelectTab = useCallback((tabId: string) => {
    setTabsState((s) => switchTabInState(s, tabId));
  }, []);

  const handleSwitchToTabByIndex = useCallback((index: number) => {
    setTabsState((s) => switchToTabByIndex(s, index));
  }, []);

  const handleNextTab = useCallback(() => {
    setTabsState((s) => nextTabInState(s));
  }, []);

  const handlePrevTab = useCallback(() => {
    setTabsState((s) => prevTabInState(s));
  }, []);

  const handleGoBack = useCallback(() => {
    setTabsState((s) => goBackInState(s));
  }, []);

  const handleGoForward = useCallback(() => {
    setTabsState((s) => goForwardInState(s));
  }, []);

  const handleSelectTask = useCallback(
    (t: V1Task | null) => {
      mutateActive(() => ({ selectedTask: t, sideOpen: t !== null }));
    },
    [mutateActive],
  );

  const goToTask = useCallback(
    async (id: string) => {
      // Pull fresh: the caller may only have the id (Home priority
      // cards, command palette), and the canonical task object is what
      // the side panel renders.
      try {
        const task = await invoke<V1Task>("v1_tasks_get", { id });
        if (task) {
          mutateActive(() => ({
            surface: "work",
            openDoc: null,
            selectedTask: task,
            sideOpen: true,
            taskScrollHint: { id: task.id },
          }));
        }
      } catch (error) {
        window.alert(`Could not open task: ${String(error)}`);
      }
    },
    [mutateActive],
  );

  const handleTaskCreated = useCallback(
    (task: V1Task) => {
      // Mirror QuickCapture's post-create flow: select the new task and
      // open the side panel so the user can fix priority/due/notes if
      // Claude's parse missed. Bumping the refresh nonce reseeds the
      // Work list at the new task's sort position. The scroll hint
      // ensures the row is visible — needed when Claude couldn't parse
      // a due date and the task lands in default-collapsed Someday.
      mutateActive(() => ({
        selectedTask: task,
        sideOpen: true,
        taskScrollHint: { id: task.id },
      }));
      setTaskRefreshNonce((n) => n + 1);
    },
    [mutateActive],
  );

  const handleTaskUpdated = useCallback(
    (fresh: V1Task) => {
      mutateActive(() => ({ selectedTask: fresh }));
      setTaskRefreshNonce((n) => n + 1);
    },
    [mutateActive],
  );

  const handleTaskComplete = useCallback(
    async (task: V1Task) => {
      try {
        await invoke("v1_tasks_complete", { id: task.id });
        mutateActive(() => ({ selectedTask: null, sideOpen: false }));
        setTaskRefreshNonce((n) => n + 1);
        // Toast with Undo. The undo is best-effort: if the user picks
        // it after the toast auto-dismisses they can still hit cmd+K
        // to find the now-archived task and restore via the audit log.
        showToast({
          kind: "success",
          text: `Done · ${task.title}`,
          action: {
            label: "Undo",
            onClick: async () => {
              try {
                await invoke("v1_tasks_uncomplete", { id: task.id });
                setTaskRefreshNonce((n) => n + 1);
                // Re-open the side panel and force the bucket to expand
                // — otherwise an undo of a Someday task leaves it
                // invisible behind the collapsed bucket.
                mutateActive(() => ({
                  selectedTask: task,
                  sideOpen: true,
                  taskScrollHint: { id: task.id },
                }));
                showToast({
                  kind: "info",
                  text: "Reopened.",
                  durationMs: 2500,
                });
              } catch (error) {
                showToast({
                  kind: "error",
                  text: `Couldn't undo: ${String(error)}`,
                  durationMs: 6000,
                });
              }
            },
          },
          durationMs: 6000,
        });
      } catch (error) {
        showToast({
          kind: "error",
          text: `Could not complete task: ${String(error)}`,
          durationMs: 6000,
        });
      }
    },
    [mutateActive],
  );

  const openPalette = useCallback(() => {
    // Time the open so PRD-101's ≤40ms warm budget is measurable.
    // The mark closes when state has propagated through to render —
    // in React 19 the next paint is one tick after setPaletteOpen.
    const done = mark("palette-open");
    setPaletteOpen(true);
    queueMicrotask(done);
  }, []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const openQuickCapture = useCallback(() => setQuickCaptureOpen(true), []);
  const closeQuickCapture = useCallback(() => setQuickCaptureOpen(false), []);
  const toggleSidebar = useCallback(
    () => setSidebarCollapsed((v) => !v),
    [],
  );
  const toggleSidePanel = useCallback(
    () => mutateActive((t) => ({ sideOpen: !t.sideOpen })),
    [mutateActive],
  );

  const handleOpenDoc = useCallback(
    (doc: OpenDoc, intent: OpenIntent = "current") => {
      // When the caller (Recent list, palette, CLI handoff) didn't
      // supply crumbs, infer them from the path so the breadcrumb
      // reads "People > Alice > 2026-05-06" instead of
      // "<current-surface> > 2026-05-06". Callers that *do* set
      // crumbs (ProjectDetail, PersonProfile, MeetingDetail) keep
      // their explicit context — this only fires on bare opens.
      const ctx = doc.crumbs ? null : inferDocContext(doc.relPath);
      const patch: Partial<TabState> = ctx
        ? {
            openDoc: { ...doc, crumbs: ctx.crumbs },
            sideOpen: false,
            surface: ctx.surface,
            peopleProfile: ctx.peopleProfile,
            projectProfile: ctx.projectProfile,
            meetingProfile: ctx.meetingProfile,
          }
        : { openDoc: doc, sideOpen: false };
      openWithIntent(intent, patch);
      // Record into the local MRU. Empty path is a no-op upstream.
      recordRecent(doc.relPath, doc.label ?? doc.relPath);
    },
    [openWithIntent],
  );
  const closeDoc = useCallback(
    () => mutateActive(() => ({ openDoc: null })),
    [mutateActive],
  );

  const closeOverlay = useCallback(() => {
    // Palette handles its own Escape and stops propagation, so by the time
    // this global handler fires the palette is already closed (or wasn't
    // open). Same for the shortcuts modal. Just dismiss the open doc.
    mutateActive(() => ({ openDoc: null }));
  }, [mutateActive]);

  const toggleShortcuts = useCallback(() => {
    setShortcutsOpen((v) => !v);
  }, []);

  const goToSurface = useCallback(
    (id: SurfaceId, intent: OpenIntent = "current") => {
      // PRD-101 budget: view-switch ≤120ms. Same close-on-microtask
      // pattern; pending React work flushes before the timer stops.
      const done = mark("view-switch", { to: id });
      openWithIntent(intent, {
        surface: id,
        openDoc: null,
        peopleProfile: null,
        projectProfile: null,
        meetingProfile: null,
      });
      queueMicrotask(done);
    },
    [openWithIntent],
  );

  const goToProfile = useCallback(
    (target: ProfileTarget, intent: OpenIntent = "current") => {
      openWithIntent(intent, {
        surface: "people",
        peopleProfile: target,
        projectProfile: null,
        meetingProfile: null,
        openDoc: null,
      });
    },
    [openWithIntent],
  );

  const clearProfile = useCallback(
    () => mutateActive(() => ({ peopleProfile: null, openDoc: null })),
    [mutateActive],
  );

  const goToProject = useCallback(
    (target: ProjectTarget, intent: OpenIntent = "current") => {
      openWithIntent(intent, {
        surface: "projects",
        projectProfile: target,
        peopleProfile: null,
        meetingProfile: null,
        openDoc: null,
      });
    },
    [openWithIntent],
  );

  const clearProject = useCallback(
    () => mutateActive(() => ({ projectProfile: null, openDoc: null })),
    [mutateActive],
  );

  const goToMeeting = useCallback(
    (target: MeetingTarget, intent: OpenIntent = "current") => {
      openWithIntent(intent, {
        surface: "meetings",
        meetingProfile: target,
        peopleProfile: null,
        projectProfile: null,
        openDoc: null,
      });
    },
    [openWithIntent],
  );

  const clearMeeting = useCallback(
    () => mutateActive(() => ({ meetingProfile: null, openDoc: null })),
    [mutateActive],
  );

  // Deep-link bus: surfaces can request navigation via a CustomEvent so we
  // don't have to plumb nav callbacks through every intermediate component.
  // PRD-v2-117 §4.12: callers extend the payload with `intent` to open
  // in a new background or foreground tab; absence defaults to "current".
  useEffect(() => {
    function onGoto(e: Event) {
      const detail = (e as CustomEvent<{
        surface?: SurfaceId;
        section?: string;
        profile?: ProfileTarget;
        project?: ProjectTarget;
        meeting?: MeetingTarget;
        intent?: OpenIntent;
      }>).detail;
      const intent = detail?.intent ?? "current";
      if (detail?.profile) {
        goToProfile(detail.profile, intent);
        return;
      }
      if (detail?.project) {
        goToProject(detail.project, intent);
        return;
      }
      if (detail?.meeting) {
        goToMeeting(detail.meeting, intent);
        return;
      }
      if (!detail?.surface) return;
      goToSurface(detail.surface, intent);
      if (detail.section) {
        // Let the destination surface finish mounting before firing its
        // own section-select event; useEffect + microtask is enough.
        queueMicrotask(() => {
          window.dispatchEvent(
            new CustomEvent(`cos:${detail.surface}-section`, {
              detail: { section: detail.section },
            }),
          );
        });
      }
    }
    window.addEventListener("cos:goto", onGoto);
    return () => window.removeEventListener("cos:goto", onGoto);
  }, [goToSurface, goToProfile, goToProject, goToMeeting]);

  // Editor → "open this doc" — fired when the user cmd-clicks an
  // intra-content link inside the editor body. Opens the resolved
  // path in the same editor instance (or in a new tab when the
  // dispatcher passes an intent).
  useEffect(() => {
    function onOpenDoc(e: Event) {
      const detail = (e as CustomEvent<{
        relPath?: string;
        label?: string;
        intent?: OpenIntent;
      }>).detail;
      if (!detail?.relPath) return;
      handleOpenDoc(
        {
          relPath: detail.relPath,
          label: detail.label ?? detail.relPath,
        },
        detail.intent ?? "current",
      );
    }
    window.addEventListener("cos:open-doc", onOpenDoc);
    return () => window.removeEventListener("cos:open-doc", onOpenDoc);
  }, [handleOpenDoc]);

  // CLI handoff: `cos open <rel-path>` drops a JSON request next to
  // the app data dir; we poll on a slow cadence (1500 ms) so a
  // freshly-typed terminal command shows up within a couple of beats.
  // Slow on purpose — the file is one-shot (read + delete) and we'd
  // rather spend 0.7 IPCs/s than register a filesystem watcher.
  // Pause when the window is hidden to avoid wasting cycles offscreen.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled || document.hidden) return;
      try {
        const req = await invoke<{ rel_path: string; label: string } | null>(
          "take_open_request",
        );
        if (req && req.rel_path) {
          handleOpenDoc({
            relPath: req.rel_path,
            label: req.label || req.rel_path.split("/").pop() || req.rel_path,
          });
        }
      } catch {
        // Backend down — fall through; next tick will retry.
      }
    };
    const id = window.setInterval(tick, 1500);
    // First tick immediately so a request fired right before launch
    // doesn't wait the full interval.
    void tick();
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [handleOpenDoc]);

  // PRD-v2-117 §4.5 — Cmd+Shift+T reopens the most recently closed
  // tab from the ring buffer. No-op when the ring is empty.
  const handleReopenClosedTab = useCallback(() => {
    setTabsState((s) => reopenLastClosedTab(s));
  }, []);

  // ---- Stage 4: pin / rename / context-menu actions ----
  const handleRenameTab = useCallback((tabId: string, title: string) => {
    setTabsState((s) => renameTabInState(s, tabId, title));
  }, []);

  const handlePinTab = useCallback((tabId: string) => {
    setTabsState((s) => pinTabInState(s, tabId));
  }, []);

  const handleUnpinTab = useCallback((tabId: string) => {
    setTabsState((s) => unpinTabInState(s, tabId));
  }, []);

  const handleDuplicateTab = useCallback((tabId: string) => {
    setTabsState((s) => duplicateTabInState(s, tabId));
  }, []);

  const handleCloseOtherTabs = useCallback((tabId: string) => {
    setTabsState((s) => closeOtherTabsInState(s, tabId));
  }, []);

  const handleCloseTabsToTheRight = useCallback((tabId: string) => {
    setTabsState((s) => closeTabsToTheRightInState(s, tabId));
  }, []);

  const handleMoveTab = useCallback((fromIndex: number, toIndex: number) => {
    setTabsState((s) => moveTabInState(s, fromIndex, toIndex));
  }, []);

  const handleStartRenameActive = useCallback(() => {
    tabStripRef.current?.startRename(tabsState.activeTabId);
  }, [tabsState.activeTabId]);

  const handleTogglePinActive = useCallback(() => {
    setTabsState((s) => {
      const t = s.tabs.find((x) => x.id === s.activeTabId);
      if (!t) return s;
      return t.pinned
        ? unpinTabInState(s, s.activeTabId)
        : pinTabInState(s, s.activeTabId);
    });
  }, []);

  // ---- Persistence (PRD §4.5) ----
  //
  // Debounced writes (500ms) — every navigation, selection, doc
  // open, or rename ticks the same write path. Tab close and quit
  // flush synchronously (the unmount effect below + the beforeunload
  // handler).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const id = window.setTimeout(() => {
      const r = writePersistedTabs(tabsState, { cleanQuit: false });
      setPersistRejected(r.kind === "rejected");
    }, 500);
    return () => window.clearTimeout(id);
  }, [tabsState]);

  // Flush on quit / before-unload. PRD §4.5: stamp cleanQuit=true
  // on the way out so the next launch knows the previous run
  // terminated normally. We also prune diagnostic blobs older than
  // the TTL (PRD §4.5 quarantine cleanup).
  useEffect(() => {
    if (typeof window === "undefined") return;
    function flush() {
      writePersistedTabs(tabsState, { cleanQuit: true });
      pruneOldDiagnostics();
    }
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, [tabsState]);

  const handleAcceptRestore = useCallback(() => {
    if (pendingRestore) setTabsState(pendingRestore);
    setPendingRestore(null);
  }, [pendingRestore]);

  const handleStartFresh = useCallback(() => {
    snapshotForCrashRecovery();
    setPendingRestore(null);
  }, []);

  useGlobalKeys({
    // The keyboard handlers always operate on the current tab — the
    // OpenIntent path is for click-modifier dispatch, not chords.
    setSurface: (id) => goToSurface(id, "current"),
    openPalette,
    openQuickCapture,
    toggleSidebar,
    toggleSidePanel,
    toggleShortcuts,
    closeOverlay,
    closeDoc,
    newTab: handleNewTab,
    closeTab: handleCloseActiveTab,
    switchToTab: handleSwitchToTabByIndex,
    nextTab: handleNextTab,
    prevTab: handlePrevTab,
    reopenClosedTab: handleReopenClosedTab,
    renameActiveTab: handleStartRenameActive,
    togglePinActiveTab: handleTogglePinActive,
    goBack: handleGoBack,
    goForward: handleGoForward,
  });

  const rememberRecent = useCallback((id: string) => {
    setRecent((prev) => [id, ...prev.filter((x) => x !== id)].slice(0, RECENT_MAX));
  }, []);

  const showingDoc = openDoc !== null;

  if (catalogMode) {
    return <Catalog />;
  }

  return (
    <div
      className="cos-shell"
      style={
        {
          "--cos-sidebar-width": `${sidebarWidth}px`,
          "--cos-side-width": `${sidePanelWidth}px`,
        } as React.CSSProperties
      }
    >
      <TabStrip
        ref={tabStripRef}
        tabs={tabsState.tabs}
        activeTabId={tabsState.activeTabId}
        onSelect={handleSelectTab}
        onClose={handleCloseTab}
        onNew={handleNewTab}
        onRename={handleRenameTab}
        onPin={handlePinTab}
        onUnpin={handleUnpinTab}
        onDuplicate={handleDuplicateTab}
        onReopenClosed={handleReopenClosedTab}
        canReopenClosed={tabsState.recentlyClosed.length > 0}
        onCloseOthers={handleCloseOtherTabs}
        onCloseTabsToTheRight={handleCloseTabsToTheRight}
        onMove={handleMoveTab}
      />
      <div
        className={`cos-app ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${
          sideOpen && !showingDoc ? "side-open" : ""
        }`}
        id={TABPANEL_ID}
        role="tabpanel"
        aria-labelledby={tabsState.activeTabId}
      >
      <Sidebar
        active={active}
        collapsed={sidebarCollapsed}
        onSelect={(id, e) =>
          goToSurface(id, e ? intentFromEvent(e) : "current")
        }
        onToggle={toggleSidebar}
        onOpenDoc={(doc, e) =>
          handleOpenDoc(doc, e ? intentFromEvent(e) : "current")
        }
      />
      {!sidebarCollapsed && (
        <ResizeHandle
          edge="right"
          width={sidebarWidth}
          setWidth={setSidebarWidth}
          min={SIDEBAR_WIDTH_MIN}
          max={SIDEBAR_WIDTH_MAX}
          ariaLabel="Resize sidebar"
        />
      )}

      <div className="cos-main-column">
        <Header
          active={active}
          openDoc={openDoc}
          peopleProfile={peopleProfile}
          projectProfile={projectProfile}
          meetingProfile={meetingProfile}
          canGoBack={readCanGoBack(tab)}
          canGoForward={readCanGoForward(tab)}
          onGoBack={handleGoBack}
          onGoForward={handleGoForward}
          onOpenPalette={openPalette}
          onOpenQuickCapture={openQuickCapture}
          onToggleSide={toggleSidePanel}
          onPopDoc={closeDoc}
          onClearProfile={clearProfile}
          onClearProject={clearProject}
          onClearMeeting={clearMeeting}
        />
        <div className="cos-content">
          <main className="cos-main-zone">
            {showingDoc ? (
              <Suspense
                fallback={<div className="cos-empty">Loading editor…</div>}
              >
                {openDoc.relPath.endsWith(".html") ? (
                  <HtmlEditor
                    relPath={openDoc.relPath}
                    label={openDoc.label}
                    onClose={closeDoc}
                  />
                ) : (
                  <DocEditor
                    relPath={openDoc.relPath}
                    label={openDoc.label}
                    onClose={closeDoc}
                    scrollTo={openDoc.scrollTo}
                  />
                )}
              </Suspense>
            ) : (
              <ErrorBoundary
                key={active}
                label={`the ${active} surface`}
              >
              <SurfaceRouter
                active={active}
                selectedTask={selectedTask}
                onSelectTask={handleSelectTask}
                onOpenDoc={handleOpenDoc}
                taskRefreshNonce={taskRefreshNonce}
                peopleProfile={peopleProfile}
                onGoToProfile={goToProfile}
                onClearProfile={clearProfile}
                onTaskCreated={handleTaskCreated}
                taskScrollHint={taskScrollHint}
                onGoToTask={goToTask}
                projectProfile={projectProfile}
                onGoToProject={goToProject}
                onClearProject={clearProject}
                meetingProfile={meetingProfile}
                onGoToMeeting={goToMeeting}
                onClearMeeting={clearMeeting}
              />
              </ErrorBoundary>
            )}
          </main>
          {sideOpen && !showingDoc && (
            <aside className="cos-side-zone" aria-label="Context panel">
              <ResizeHandle
                edge="left"
                width={sidePanelWidth}
                setWidth={setSidePanelWidth}
                min={SIDE_PANEL_WIDTH_MIN}
                max={SIDE_PANEL_WIDTH_MAX}
                ariaLabel="Resize context panel"
              />
              <SurfaceSidePanel
                active={active}
                selectedTask={selectedTask}
                onTaskUpdated={handleTaskUpdated}
                onTaskComplete={handleTaskComplete}
              />
            </aside>
          )}
        </div>
      </div>
      </div>

      <CommandPalette
        open={paletteOpen}
        recent={recent}
        openTabs={tabsState.tabs}
        context={{
          setSurface: goToSurface,
          toggleSidebar,
          toggleSidePanel,
          openDoc: (relPath, label) =>
            handleOpenDoc({ relPath, label }),
          goToTask,
          goToProfile,
          goToMeeting,
          goToProject,
          switchToTab: handleSelectTab,
        }}
        onDismiss={closePalette}
        onRan={rememberRecent}
      />

      <QuickCapture
        open={quickCaptureOpen}
        onDismiss={closeQuickCapture}
        onCreated={(task) => {
          // QuickCapture can fire from any surface, so route to Work
          // first. Inline-row creations on Work go straight through
          // handleTaskCreated and skip the surface change.
          goToSurface("work");
          handleTaskCreated(task);
        }}
      />

      <ToastHost />
      <UpdateBanner />

      {wizardOpen && (
        <InstallWizard onDismiss={() => setWizardOpen(false)} />
      )}

      {shortcutsOpen && (
        <ShortcutsModal onClose={() => setShortcutsOpen(false)} />
      )}

      {pendingRestore && (
        <CrashRecoveryPrompt
          tabCount={pendingRestore.tabs.length}
          onRestore={handleAcceptRestore}
          onStartFresh={handleStartFresh}
        />
      )}

      {persistRejected && (
        <div
          className="cos-tabs-persist-warning"
          role="status"
          aria-live="polite"
          title="Tab state isn't being saved — close some tabs to bring the strip back under the size budget."
        >
          Tab state not saving — close tabs to resume
        </div>
      )}
    </div>
  );
}
