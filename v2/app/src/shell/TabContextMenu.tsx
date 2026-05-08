/**
 * Right-click context menu for a workspace tab (PRD-v2-117 §4.10).
 *
 * Anchors to the click position; closes on outside click, Esc, or
 * any item activation. The host component owns the action handlers
 * and decides which items are enabled — this component is pure
 * rendering.
 */

import { useEffect, useRef } from "react";

export type TabMenuPosition = { x: number; y: number };

export type TabMenuItem = {
  label: string;
  onSelect: () => void;
  /** When true, the row renders dimmed and is non-clickable. */
  disabled?: boolean;
  /** Optional shortcut hint shown right-aligned. */
  shortcut?: string;
  /** Optional separator after this item (visual rule). */
  separatorAfter?: boolean;
};

export type TabContextMenuProps = {
  position: TabMenuPosition;
  items: TabMenuItem[];
  onClose: () => void;
};

export function TabContextMenu({
  position,
  items,
  onClose,
}: TabContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  // Outside-click + Esc dismiss. Capture-phase listener so we close
  // before any of the parent click handlers see the event.
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

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Tab actions"
      className="cos-tab-menu"
      style={{ top: position.y, left: position.x }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => (
        <div key={`${item.label}-${i}`}>
          <button
            type="button"
            role="menuitem"
            className="cos-tab-menu-item"
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              item.onSelect();
              onClose();
            }}
          >
            <span className="cos-tab-menu-label">{item.label}</span>
            {item.shortcut && (
              <span className="cos-tab-menu-shortcut">{item.shortcut}</span>
            )}
          </button>
          {item.separatorAfter && <div className="cos-tab-menu-sep" />}
        </div>
      ))}
    </div>
  );
}
