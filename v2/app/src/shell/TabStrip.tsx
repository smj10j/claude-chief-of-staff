/**
 * PRD-v2-117 — workspace tab strip.
 *
 * Stage 2: visible strip + click handlers + ARIA tablist.
 * Stage 4: pinned tabs (icon-only chips), inline rename
 * (double-click / F2 / right-click), right-click context menu.
 *
 * Drag-reorder, arrow-key roving tabindex, and the overflow chevron
 * popover are still pending stage-4 polish.
 */

import { ChevronDown, Loader2, Plus, X } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

import { useRunning } from "../state/skillRuns";
import { findSurface, type SurfaceId } from "../state/surfaces";
import {
  deriveTitle,
  intentFromEvent,
  tabHasRunningSkill,
  type TabState,
} from "../state/tabs";
import { TabContextMenu, type TabMenuItem } from "./TabContextMenu";

export const TABPANEL_ID = "cos-active-tabpanel";

export type TabStripHandle = {
  /** Programmatically start renaming a tab (F2 / context menu). */
  startRename: (tabId: string) => void;
};

export type TabStripProps = {
  tabs: readonly TabState[];
  activeTabId: string;
  /** Switch to the tab. Plain click. */
  onSelect: (tabId: string) => void;
  /** Close the tab. Hover-revealed × button or middle-click. */
  onClose: (tabId: string) => void;
  /** New tab affordance ("+" button or Cmd+T). */
  onNew: () => void;
  /** Rename the tab (commit Enter, or empty submit clears). */
  onRename: (tabId: string, title: string) => void;
  /** Pin / unpin from the right-click menu or Cmd+Shift+L. */
  onPin: (tabId: string) => void;
  onUnpin: (tabId: string) => void;
  /** Duplicate the tab from the right-click menu. */
  onDuplicate: (tabId: string) => void;
  /** Reopen most recently closed (right-click → Reopen closed tab). */
  onReopenClosed: () => void;
  /** True when the recently-closed ring buffer has at least one entry. */
  canReopenClosed: boolean;
  /** Close every unpinned tab except the right-clicked one. */
  onCloseOthers: (tabId: string) => void;
  /** Close every unpinned tab to the right of the right-clicked tab. */
  onCloseTabsToTheRight: (tabId: string) => void;
  /** Drag-reorder: move a tab from `fromIndex` to `toIndex`
   *  (PRD §4.2 / criterion #12). The reducer enforces the
   *  pin-region clamp; this prop is just the dispatcher. */
  onMove: (fromIndex: number, toIndex: number) => void;
};

export const TabStrip = forwardRef<TabStripHandle, TabStripProps>(
  function TabStrip(
    {
      tabs,
      activeTabId,
      onSelect,
      onClose,
      onNew,
      onRename,
      onPin,
      onUnpin,
      onDuplicate,
      onReopenClosed,
      canReopenClosed,
      onCloseOthers,
      onCloseTabsToTheRight,
      onMove,
    },
    ref,
  ) {
    const stripRef = useRef<HTMLDivElement | null>(null);
    /**
     * In-flight drag tracker for pointer-events-based reorder.
     *
     * We deliberately avoid HTML5 native drag (`draggable={true}` +
     * `dragstart`/`dragover`/`drop`). WebKit on macOS — the engine
     * Tauri uses — has a long history of quirks with that API:
     * custom MIME types stripped during `dragover` ("protected
     * mode"), `dropEffect`/`effectAllowed` mismatches that show the
     * wrong cursor and silently reject drops, and subtle regressions
     * across OS updates. Pointer events ({pointerdown, pointermove,
     * pointerup}) behave identically across Chromium and WebKit and
     * gave us a stable, testable foundation.
     *
     * `null` between drags. Set on pointerdown; updated on
     * pointermove; consumed (or cleared) on pointerup / Escape /
     * pointercancel.
     */
    const dragStateRef = useRef<{
      fromIndex: number;
      toIndex: number;
      startX: number;
      startY: number;
      isDragging: boolean;
    } | null>(null);
    /**
     * Click-suppression flag. Pointer events don't auto-suppress the
     * synthetic `click` that fires after pointerup, so a successful
     * drag would otherwise re-fire `onSelect` on the source tab. We
     * set this in pointerup-after-drag, the click handler reads it,
     * and a microtask clears it.
     */
    const justDraggedRef = useRef(false);
    const runningRuns = useRunning();
    const [renamingId, setRenamingId] = useState<string | null>(null);
    /** Polite live-region announcement string. Updated on tab open
     *  / switch / close so VoiceOver + NVDA users hear the change.
     *  PRD §4.11. */
    const [announcement, setAnnouncement] = useState("");
    const prevActiveIdRef = useRef(activeTabId);
    const prevCountRef = useRef(tabs.length);

    // Announce tab open / switch / close on each change.
    useEffect(() => {
      const prevCount = prevCountRef.current;
      const prevActive = prevActiveIdRef.current;
      const activeIdx = tabs.findIndex((t) => t.id === activeTabId);
      const activeTitle = activeIdx >= 0 ? deriveTitle(tabs[activeIdx]!) : "";
      if (tabs.length > prevCount) {
        setAnnouncement(
          `Tab ${activeTitle} opened, ${activeIdx + 1} of ${tabs.length}`,
        );
      } else if (tabs.length < prevCount) {
        setAnnouncement(
          `Closed tab. ${tabs.length} tabs remain. Press Cmd+Shift+T to reopen.`,
        );
      } else if (activeTabId !== prevActive && activeIdx >= 0) {
        setAnnouncement(`Switched to tab ${activeTitle}`);
      }
      prevCountRef.current = tabs.length;
      prevActiveIdRef.current = activeTabId;
    }, [tabs, activeTabId]);
    const [menuFor, setMenuFor] = useState<{
      tabId: string;
      position: { x: number; y: number };
    } | null>(null);
    /**
     * During drag, `dragOver` holds the live drag state so the tab
     * strip can render the lift on the source tab plus the insertion
     * indicator on the target slot.
     *
     *   fromIndex — source tab (gets `is-dragging`, dimmed + lifted)
     *   toIndex   — insertion slot (drop-before/after on neighbor)
     *   dx        — horizontal cursor delta from pointerdown; the
     *               source tab translates by this amount so it
     *               visually follows the cursor
     *
     * `null` when no drag is active.
     */
    const [dragOver, setDragOver] = useState<{
      fromIndex: number;
      toIndex: number;
      dx: number;
    } | null>(null);
    /** Open-state for the overflow chevron popover (criterion #11). */
    const [overflowOpen, setOverflowOpen] = useState(false);
    const [overflowFilter, setOverflowFilter] = useState("");

    useImperativeHandle(
      ref,
      () => ({
        startRename: (tabId: string) => setRenamingId(tabId),
      }),
      [],
    );

    // Auto-scroll the active tab into view on switch.
    useEffect(() => {
      const el = stripRef.current?.querySelector<HTMLElement>(
        `[data-tab-id="${activeTabId}"]`,
      );
      if (el) el.scrollIntoView({ block: "nearest", inline: "nearest" });
    }, [activeTabId]);

    const handleContext = useCallback(
      (e: React.MouseEvent<HTMLDivElement>, tabId: string) => {
        e.preventDefault();
        setMenuFor({ tabId, position: { x: e.clientX, y: e.clientY } });
      },
      [],
    );

    /**
     * Roving tabindex (PRD §4.11): when the strip itself has focus,
     * Left/Right move focus across tabs without activating; Home/End
     * jump to the ends. The Tab key escapes the strip via the
     * standard browser focus order.
     */
    const handleStripKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (renamingId) return;
        const target = e.target as HTMLElement | null;
        if (!target || target.getAttribute("role") !== "tab") return;
        const ids = tabs.map((t) => t.id);
        const here = target.getAttribute("data-tab-id");
        if (!here) return;
        const idx = ids.indexOf(here);
        if (idx < 0) return;

        let nextIdx: number | null = null;
        if (e.key === "ArrowRight") nextIdx = Math.min(idx + 1, ids.length - 1);
        else if (e.key === "ArrowLeft") nextIdx = Math.max(idx - 1, 0);
        else if (e.key === "Home") nextIdx = 0;
        else if (e.key === "End") nextIdx = ids.length - 1;

        if (nextIdx === null || nextIdx === idx) return;
        e.preventDefault();
        const nextEl =
          stripRef.current?.querySelector<HTMLElement>(
            `[data-tab-id="${ids[nextIdx]}"]`,
          ) ?? null;
        nextEl?.focus();
      },
      [tabs, renamingId],
    );

    // ---- Drag-reorder (PRD §4.2 / criterion #12) ----
    //
    // Pointer-events implementation. See `dragStateRef` JSDoc above
    // for why we don't use HTML5 native drag. The flow:
    //   pointerdown on a tab  → record source index + start position
    //   pointermove  (window) → past 5px threshold? mark dragging,
    //                           hit-test the strip to compute toIndex
    //   pointerup    (window) → if dragging, dispatch onMove
    //   Escape       (window) → cancel
    //   pointercancel(window) → cancel (system gesture / lost capture)
    const handlePointerDown = useCallback(
      (e: React.PointerEvent<HTMLDivElement>, fromIndex: number) => {
        // Left-button only. Middle (close on aux) and right (context
        // menu) have their own handlers and must not start a drag.
        if (e.button !== 0) return;
        if (renamingId) return;
        dragStateRef.current = {
          fromIndex,
          toIndex: fromIndex,
          startX: e.clientX,
          startY: e.clientY,
          isDragging: false,
        };
      },
      [renamingId],
    );

    /**
     * Hit-test the strip: given a cursor X, return the insertion
     * index. Compare cursor against each tab's horizontal midpoint —
     * left half of tab N → toIndex = N (insert before), right half →
     * toIndex = N+1 (insert after). Past the rightmost tab → end.
     */
    const computeToIndex = useCallback((clientX: number): number => {
      const stripEl = stripRef.current;
      if (!stripEl) return 0;
      const tabEls = stripEl.querySelectorAll<HTMLElement>(
        '[role="tab"][data-tab-id]',
      );
      for (let i = 0; i < tabEls.length; i++) {
        const rect = tabEls[i]!.getBoundingClientRect();
        const half = rect.left + rect.width / 2;
        if (clientX < half) return i;
      }
      return tabEls.length;
    }, []);

    useEffect(() => {
      function onPointerMove(e: PointerEvent) {
        const drag = dragStateRef.current;
        if (!drag) return;
        const dx = e.clientX - drag.startX;
        if (!drag.isDragging) {
          // 5px threshold so a click-without-move doesn't accidentally
          // turn into a drag. Matches Chromium/macOS native drag feel.
          const dy = e.clientY - drag.startY;
          if (Math.hypot(dx, dy) < 5) return;
          drag.isDragging = true;
        }
        const toIndex = computeToIndex(e.clientX);
        drag.toIndex = toIndex;
        setDragOver({ fromIndex: drag.fromIndex, toIndex, dx });
      }

      function onPointerUp() {
        const drag = dragStateRef.current;
        dragStateRef.current = null;
        setDragOver(null);
        if (!drag || !drag.isDragging) return;
        // Suppress the synthetic click that fires after pointerup —
        // otherwise a successful drag also re-selects the source tab.
        justDraggedRef.current = true;
        queueMicrotask(() => {
          justDraggedRef.current = false;
        });
        onMove(drag.fromIndex, drag.toIndex);
      }

      function onCancel() {
        // pointercancel + Escape: drop without committing. The user
        // either backed out (Esc) or the system aborted the gesture
        // (e.g., a higher-priority gesture took over).
        dragStateRef.current = null;
        setDragOver(null);
      }

      function onKey(e: KeyboardEvent) {
        if (e.key === "Escape" && dragStateRef.current) onCancel();
      }

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKey);
      return () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKey);
      };
    }, [onMove, computeToIndex]);

    const wasJustDragged = useCallback(() => justDraggedRef.current, []);

    const renameCommit = useCallback(
      (tabId: string, title: string) => {
        onRename(tabId, title);
        setRenamingId(null);
      },
      [onRename],
    );

    const renameCancel = useCallback(() => setRenamingId(null), []);

    const menuItems = useMemo<TabMenuItem[]>(() => {
      if (!menuFor) return [];
      const tab = tabs.find((t) => t.id === menuFor.tabId);
      if (!tab) return [];
      return [
        {
          label: "Reopen closed tab",
          onSelect: onReopenClosed,
          disabled: !canReopenClosed,
          shortcut: "⌘⇧T",
          separatorAfter: true,
        },
        {
          label: tab.pinned ? "Unpin tab" : "Pin tab",
          onSelect: () =>
            tab.pinned ? onUnpin(tab.id) : onPin(tab.id),
          shortcut: "⌘⇧L",
        },
        {
          label: "Rename",
          onSelect: () => setRenamingId(tab.id),
          shortcut: "F2",
        },
        ...(tab.userTitle && tab.userTitle.trim().length > 0
          ? [
              {
                label: "Reset title to auto",
                onSelect: () => onRename(tab.id, ""),
                separatorAfter: true,
              } satisfies TabMenuItem,
            ]
          : [{ label: "", onSelect: () => {}, separatorAfter: true } as never].filter(
              () => false,
            )),
        {
          label: "Duplicate tab",
          onSelect: () => onDuplicate(tab.id),
          separatorAfter: true,
        },
        {
          label: "Close tab",
          onSelect: () => onClose(tab.id),
          shortcut: "⌘W",
        },
        {
          label: "Close other tabs",
          onSelect: () => onCloseOthers(tab.id),
        },
        {
          label: "Close tabs to the right",
          onSelect: () => onCloseTabsToTheRight(tab.id),
        },
      ];
    }, [
      menuFor,
      tabs,
      onReopenClosed,
      canReopenClosed,
      onPin,
      onUnpin,
      onRename,
      onDuplicate,
      onClose,
      onCloseOthers,
      onCloseTabsToTheRight,
    ]);

    return (
      <>
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="cos-sr-only"
        >
          {announcement}
        </div>
        <div
          ref={stripRef}
          className="cos-workspace-tabs"
          role="tablist"
          aria-label="Workspace tabs"
          aria-orientation="horizontal"
          onKeyDown={handleStripKeyDown}
        >
          <div className="cos-workspace-tabs-scroller">
            {tabs.map((t, i) => (
              <WorkspaceTab
                key={t.id}
                index={i}
                tab={t}
                active={t.id === activeTabId}
                renaming={t.id === renamingId}
                running={tabHasRunningSkill(t, runningRuns)}
                showInsertBefore={
                  dragOver !== null && dragOver.toIndex === i &&
                  dragOver.fromIndex !== i &&
                  dragOver.fromIndex + 1 !== i
                }
                showInsertAfter={
                  dragOver !== null &&
                  dragOver.toIndex === i + 1 &&
                  dragOver.fromIndex !== i &&
                  dragOver.fromIndex !== i + 1 &&
                  i === tabs.length - 1
                }
                isDragSource={
                  dragOver !== null && dragOver.fromIndex === i
                }
                dragOffsetX={
                  dragOver !== null && dragOver.fromIndex === i
                    ? dragOver.dx
                    : 0
                }
                onSelect={onSelect}
                onClose={onClose}
                onContext={handleContext}
                onStartRename={() => setRenamingId(t.id)}
                onRenameCommit={renameCommit}
                onRenameCancel={renameCancel}
                onPointerDown={handlePointerDown}
                wasJustDragged={wasJustDragged}
              />
            ))}
          </div>
          <button
            type="button"
            className="cos-workspace-tabs-add"
            onClick={onNew}
            aria-label="New tab (Cmd+T)"
            title="New tab — ⌘T"
          >
            <Plus size={16} strokeWidth={1.75} aria-hidden />
          </button>
          <button
            type="button"
            className="cos-workspace-tabs-overflow"
            onClick={() => setOverflowOpen((v) => !v)}
            aria-label="Show all tabs"
            aria-haspopup="menu"
            aria-expanded={overflowOpen}
            title="Show all tabs"
          >
            <ChevronDown size={16} strokeWidth={1.75} aria-hidden />
          </button>
        </div>
        {overflowOpen && (
          <OverflowPopover
            tabs={tabs}
            activeTabId={activeTabId}
            filter={overflowFilter}
            setFilter={setOverflowFilter}
            onPick={(id) => {
              onSelect(id);
              setOverflowOpen(false);
              setOverflowFilter("");
            }}
            onClose={() => {
              setOverflowOpen(false);
              setOverflowFilter("");
            }}
          />
        )}
        {menuFor && (
          <TabContextMenu
            position={menuFor.position}
            items={menuItems}
            onClose={() => setMenuFor(null)}
          />
        )}
      </>
    );
  },
);

type WorkspaceTabProps = {
  tab: TabState;
  index: number;
  active: boolean;
  renaming: boolean;
  running: boolean;
  showInsertBefore: boolean;
  showInsertAfter: boolean;
  /** True for the source tab while a drag is in flight — gets the
   *  lift styles (translate, shadow, dim) so the user can see what
   *  they're holding. */
  isDragSource: boolean;
  /** Horizontal cursor delta from pointerdown; the source tab uses
   *  this to translate so it visually follows the cursor. 0 for
   *  non-source tabs and when no drag is active. */
  dragOffsetX: number;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onContext: (e: React.MouseEvent<HTMLDivElement>, tabId: string) => void;
  onStartRename: () => void;
  onRenameCommit: (tabId: string, title: string) => void;
  onRenameCancel: () => void;
  onPointerDown: (
    e: React.PointerEvent<HTMLDivElement>,
    fromIndex: number,
  ) => void;
  /** Returns true if a drag completed on the *previous* microtask;
   *  used to suppress the synthetic click that follows pointerup. */
  wasJustDragged: () => boolean;
};

function WorkspaceTab({
  tab,
  index,
  active,
  renaming,
  running,
  showInsertBefore,
  showInsertAfter,
  isDragSource,
  dragOffsetX,
  onSelect,
  onClose,
  onContext,
  onStartRename,
  onRenameCommit,
  onRenameCancel,
  onPointerDown,
  wasJustDragged,
}: WorkspaceTabProps) {
  const title = useMemo(() => deriveTitle(tab), [tab]);
  const Icon = useMemo(() => surfaceIcon(tab.surface), [tab.surface]);
  const pinned = !!tab.pinned;

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.button === 1) {
        e.preventDefault();
        onClose(tab.id);
        return;
      }
      // Suppress the synthetic click after a drag — the pointer-up
      // handler already consumed the gesture by calling onMove.
      if (wasJustDragged()) return;
      onSelect(tab.id);
    },
    [tab.id, onSelect, onClose, wasJustDragged],
  );

  const handleAuxClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.button === 1) {
        e.preventDefault();
        onClose(tab.id);
      }
    },
    [tab.id, onClose],
  );

  const handleCloseClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      onClose(tab.id);
    },
    [tab.id, onClose],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (renaming) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSelect(tab.id);
      }
    },
    [tab.id, onSelect, renaming],
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      onStartRename();
    },
    [onStartRename],
  );

  return (
    <div
      role="tab"
      aria-selected={active}
      aria-controls={TABPANEL_ID}
      tabIndex={active ? 0 : -1}
      data-tab-id={tab.id}
      className={`cos-workspace-tab ${active ? "is-active" : ""} ${
        pinned ? "is-pinned" : ""
      } ${showInsertBefore ? "drop-before" : ""} ${
        showInsertAfter ? "drop-after" : ""
      } ${isDragSource ? "is-dragging" : ""}`}
      style={
        isDragSource ? { transform: `translateX(${dragOffsetX}px)` } : undefined
      }
      onPointerDown={(e) => onPointerDown(e, index)}
      onClick={handleClick}
      onAuxClick={handleAuxClick}
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault();
      }}
      onContextMenu={(e) => onContext(e, tab.id)}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
      title={title}
    >
      {running ? (
        <Loader2
          size={14}
          strokeWidth={2}
          aria-hidden
          aria-label="Skill running"
          className="cos-workspace-tab-icon cos-workspace-tab-spinner"
        />
      ) : (
        <Icon
          size={14}
          strokeWidth={1.75}
          aria-hidden
          className="cos-workspace-tab-icon"
        />
      )}
      {renaming ? (
        <RenameInput
          initial={tab.userTitle ?? title}
          onCommit={(v) => onRenameCommit(tab.id, v)}
          onCancel={onRenameCancel}
        />
      ) : (
        !pinned && <span className="cos-workspace-tab-label">{title}</span>
      )}
      {!pinned && !renaming && (
        <button
          type="button"
          className="cos-workspace-tab-close"
          onClick={handleCloseClick}
          aria-label={`Close tab ${title}`}
          tabIndex={-1}
        >
          <X size={12} strokeWidth={2} aria-hidden />
        </button>
      )}
    </div>
  );
}

type RenameInputProps = {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
};

function RenameInput({ initial, onCommit, onCancel }: RenameInputProps) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    // Pre-select so a single keystroke replaces the title.
    inputRef.current?.select();
  }, []);
  return (
    <input
      ref={inputRef}
      type="text"
      className="cos-workspace-tab-rename-input"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit(value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
        // Stop propagation so global shortcuts (Cmd+W etc.) don't
        // fire while the user is typing the new name.
        e.stopPropagation();
      }}
      onBlur={() => onCommit(value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      aria-label="Rename tab"
    />
  );
}

function surfaceIcon(id: SurfaceId) {
  try {
    return findSurface(id).icon;
  } catch {
    return findSurface("home").icon;
  }
}

/**
 * Overflow chevron popover (PRD §4.2 / criterion #11). Lists every
 * tab vertically with type-ahead filter. Click an entry to switch;
 * Esc closes; click outside closes.
 */
type OverflowPopoverProps = {
  tabs: readonly TabState[];
  activeTabId: string;
  filter: string;
  setFilter: (v: string) => void;
  onPick: (tabId: string) => void;
  onClose: () => void;
};

function OverflowPopover({
  tabs,
  activeTabId,
  filter,
  setFilter,
  onPick,
  onClose,
}: OverflowPopoverProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    function onPointer(e: MouseEvent) {
      if (!ref.current) return;
      if (ref.current.contains(e.target as Node)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("mousedown", onPointer, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onPointer, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  const q = filter.trim().toLowerCase();
  const visible = q.length === 0
    ? tabs
    : tabs.filter((t) => deriveTitle(t).toLowerCase().includes(q));

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="All tabs"
      className="cos-workspace-tabs-overflow-popover"
    >
      <input
        ref={inputRef}
        type="search"
        className="cos-workspace-tabs-overflow-filter"
        placeholder={`Filter ${tabs.length} tabs…`}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && visible.length > 0) {
            e.preventDefault();
            onPick(visible[0]!.id);
          }
        }}
        aria-label="Filter tabs"
      />
      <ul className="cos-workspace-tabs-overflow-list">
        {visible.map((t) => {
          const Icon = surfaceIcon(t.surface);
          const title = deriveTitle(t);
          const active = t.id === activeTabId;
          return (
            <li key={t.id}>
              <button
                type="button"
                role="menuitem"
                className={`cos-workspace-tabs-overflow-item ${
                  active ? "is-active" : ""
                }`}
                onClick={() => onPick(t.id)}
              >
                <Icon
                  size={14}
                  strokeWidth={1.75}
                  aria-hidden
                  className="cos-workspace-tab-icon"
                />
                <span className="cos-workspace-tabs-overflow-label">
                  {title}
                </span>
                {t.pinned && (
                  <span className="cos-workspace-tabs-overflow-pinned">
                    pinned
                  </span>
                )}
              </button>
            </li>
          );
        })}
        {visible.length === 0 && (
          <li className="cos-workspace-tabs-overflow-empty">No matches.</li>
        )}
      </ul>
    </div>
  );
}

export { intentFromEvent };
