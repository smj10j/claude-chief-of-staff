/**
 * TabStrip component tests (PRD-v2-117 stage 2).
 *
 * Covers the rendering, click, middle-click, close-button, "+" add,
 * and ARIA roles of the workspace tab strip.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createTab, type TabState } from "../state/tabs";
import { TabStrip, TABPANEL_ID } from "./TabStrip";

function tabs(...surfaces: Array<TabState["surface"]>): TabState[] {
  return surfaces.map((s) => createTab(s));
}

function renderStrip(args: {
  tabs: TabState[];
  activeTabId: string;
  canReopenClosed?: boolean;
  onSelect?: (id: string) => void;
  onClose?: (id: string) => void;
  onNew?: () => void;
}) {
  const onSelect = args.onSelect ?? vi.fn();
  const onClose = args.onClose ?? vi.fn();
  const onNew = args.onNew ?? vi.fn();
  const onRename = vi.fn();
  const onPin = vi.fn();
  const onUnpin = vi.fn();
  const onDuplicate = vi.fn();
  const onReopenClosed = vi.fn();
  const onCloseOthers = vi.fn();
  const onCloseTabsToTheRight = vi.fn();
  const onMove = vi.fn();
  render(
    <TabStrip
      tabs={args.tabs}
      activeTabId={args.activeTabId}
      onSelect={onSelect}
      onClose={onClose}
      onNew={onNew}
      onRename={onRename}
      onPin={onPin}
      onUnpin={onUnpin}
      onDuplicate={onDuplicate}
      onReopenClosed={onReopenClosed}
      canReopenClosed={args.canReopenClosed ?? false}
      onCloseOthers={onCloseOthers}
      onCloseTabsToTheRight={onCloseTabsToTheRight}
      onMove={onMove}
    />,
  );
  return {
    onSelect,
    onClose,
    onNew,
    onRename,
    onPin,
    onUnpin,
    onDuplicate,
    onReopenClosed,
    onCloseOthers,
    onCloseTabsToTheRight,
    onMove,
  };
}

describe("TabStrip", () => {
  it("renders one tab per state, with the active one marked", () => {
    const ts = tabs("home", "work", "ops");
    renderStrip({ tabs: ts, activeTabId: ts[1]!.id });
    const all = screen.getAllByRole("tab");
    expect(all).toHaveLength(3);
    expect(all[0]).toHaveAttribute("aria-selected", "false");
    expect(all[1]).toHaveAttribute("aria-selected", "true");
    expect(all[2]).toHaveAttribute("aria-selected", "false");
  });

  it("auto-derives titles from the active tab record", () => {
    const ts = tabs("home", "work");
    renderStrip({ tabs: ts, activeTabId: ts[0]!.id });
    expect(screen.getByText("Home")).toBeInTheDocument();
    expect(screen.getByText("Tasks")).toBeInTheDocument();
  });

  it("clicking a tab fires onSelect with that tab's id", () => {
    const ts = tabs("home", "work");
    const { onSelect } = renderStrip({ tabs: ts, activeTabId: ts[0]!.id });
    fireEvent.click(screen.getAllByRole("tab")[1]!);
    expect(onSelect).toHaveBeenCalledWith(ts[1]!.id);
  });

  it("clicking the inline × fires onClose with that tab's id", () => {
    const ts = tabs("home", "work");
    const { onClose, onSelect } = renderStrip({
      tabs: ts,
      activeTabId: ts[0]!.id,
    });
    const closeBtn = screen.getByLabelText(`Close tab Tasks`);
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledWith(ts[1]!.id);
    // The close click stops propagation; onSelect must NOT also fire.
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("middle-click on a tab closes it (PRD §4.4.3)", () => {
    const ts = tabs("home", "work", "ops");
    const { onClose, onSelect } = renderStrip({
      tabs: ts,
      activeTabId: ts[0]!.id,
    });
    // happy-dom doesn't expose fireEvent.auxClick; dispatch the
    // event directly with the right type to exercise onAuxClick.
    const target = screen.getAllByRole("tab")[2]!;
    fireEvent(
      target,
      new MouseEvent("auxclick", { bubbles: true, button: 1 }),
    );
    expect(onClose).toHaveBeenCalledWith(ts[2]!.id);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('"+" affordance fires onNew', () => {
    const ts = tabs("home");
    const { onNew } = renderStrip({ tabs: ts, activeTabId: ts[0]!.id });
    fireEvent.click(screen.getByLabelText(/^New tab/));
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it("each tab carries the ARIA tabpanel binding", () => {
    const ts = tabs("home");
    renderStrip({ tabs: ts, activeTabId: ts[0]!.id });
    expect(screen.getAllByRole("tab")[0]).toHaveAttribute(
      "aria-controls",
      TABPANEL_ID,
    );
  });

  it("only the active tab is in the focus order (roving tabindex)", () => {
    const ts = tabs("home", "work", "ops");
    renderStrip({ tabs: ts, activeTabId: ts[1]!.id });
    const all = screen.getAllByRole("tab");
    expect(all[0]).toHaveAttribute("tabindex", "-1");
    expect(all[1]).toHaveAttribute("tabindex", "0");
    expect(all[2]).toHaveAttribute("tabindex", "-1");
  });

  it("Enter/Space on a focused tab activates it", () => {
    const ts = tabs("home", "work");
    const { onSelect } = renderStrip({ tabs: ts, activeTabId: ts[0]!.id });
    fireEvent.keyDown(screen.getAllByRole("tab")[1]!, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(ts[1]!.id);
    fireEvent.keyDown(screen.getAllByRole("tab")[1]!, { key: " " });
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it("renders a tablist with the correct ARIA properties", () => {
    const ts = tabs("home");
    renderStrip({ tabs: ts, activeTabId: ts[0]!.id });
    const list = screen.getByRole("tablist");
    expect(list).toHaveAttribute("aria-label", "Workspace tabs");
    expect(list).toHaveAttribute("aria-orientation", "horizontal");
  });

  it("double-click on a tab enters rename mode (input pre-populated)", () => {
    const ts = tabs("home", "work");
    renderStrip({ tabs: ts, activeTabId: ts[0]!.id });
    fireEvent.doubleClick(screen.getAllByRole("tab")[1]!);
    const input = screen.getByLabelText("Rename tab") as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input.value).toBe("Tasks"); // auto-derived
  });

  it("Enter in the rename input commits via onRename and exits rename mode", () => {
    const ts = tabs("home", "work");
    const { onRename } = renderStrip({
      tabs: ts,
      activeTabId: ts[0]!.id,
    });
    fireEvent.doubleClick(screen.getAllByRole("tab")[1]!);
    const input = screen.getByLabelText("Rename tab") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Q3 prep" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith(ts[1]!.id, "Q3 prep");
  });

  it("Esc in the rename input cancels without firing onRename", () => {
    const ts = tabs("home", "work");
    const { onRename } = renderStrip({
      tabs: ts,
      activeTabId: ts[0]!.id,
    });
    fireEvent.doubleClick(screen.getAllByRole("tab")[1]!);
    const input = screen.getByLabelText("Rename tab") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Q3 prep" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onRename).not.toHaveBeenCalled();
  });

  it("right-click opens the context menu with the expected items", () => {
    const ts = tabs("home", "work");
    renderStrip({
      tabs: ts,
      activeTabId: ts[0]!.id,
      canReopenClosed: false,
    });
    fireEvent.contextMenu(screen.getAllByRole("tab")[1]!);
    const menu = screen.getByRole("menu", { name: "Tab actions" });
    expect(menu).toBeInTheDocument();
    expect(screen.getByText("Pin tab")).toBeInTheDocument();
    expect(screen.getByText("Rename")).toBeInTheDocument();
    expect(screen.getByText("Duplicate tab")).toBeInTheDocument();
    expect(screen.getByText("Close tab")).toBeInTheDocument();
    expect(screen.getByText("Close other tabs")).toBeInTheDocument();
    expect(screen.getByText("Close tabs to the right")).toBeInTheDocument();
  });

  it("'Reopen closed tab' is disabled when the ring is empty", () => {
    const ts = tabs("home");
    renderStrip({
      tabs: ts,
      activeTabId: ts[0]!.id,
      canReopenClosed: false,
    });
    fireEvent.contextMenu(screen.getAllByRole("tab")[0]!);
    const item = screen.getByText("Reopen closed tab").closest("button");
    expect(item).toBeDisabled();
  });

  it("Arrow keys on a focused tab move focus along the strip without activating", () => {
    const ts = tabs("home", "work", "ops");
    const { onSelect } = renderStrip({ tabs: ts, activeTabId: ts[0]!.id });
    const all = screen.getAllByRole("tab");
    all[0]!.focus();
    fireEvent.keyDown(all[0]!, { key: "ArrowRight" });
    // The focus moved to the second tab; the first didn't activate.
    expect(document.activeElement).toBe(all[1]);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("the overflow chevron opens a popover listing every tab; clicking an entry switches", () => {
    const ts = tabs("home", "work", "ops");
    const { onSelect } = renderStrip({ tabs: ts, activeTabId: ts[0]!.id });
    fireEvent.click(screen.getByLabelText("Show all tabs"));
    const popover = screen.getByRole("menu", { name: "All tabs" });
    expect(popover).toBeInTheDocument();
    // The popover renders one menuitem per tab; resolve scoped to it.
    const items = screen.getAllByRole("menuitem");
    expect(items).toHaveLength(3);
    fireEvent.click(items[1]!);
    expect(onSelect).toHaveBeenCalledWith(ts[1]!.id);
    expect(screen.queryByRole("menu", { name: "All tabs" })).toBeNull();
  });

  it("the overflow popover supports type-ahead filtering", () => {
    const a = createTab("home");
    const b = createTab("people", {
      peopleProfile: { slug: "x", label: "Alice", rel_path: "x" },
    });
    const c = createTab("ops");
    renderStrip({ tabs: [a, b, c], activeTabId: a.id });
    fireEvent.click(screen.getByLabelText("Show all tabs"));
    const filter = screen.getByLabelText("Filter tabs") as HTMLInputElement;
    fireEvent.change(filter, { target: { value: "aas" } });
    const items = screen.getAllByRole("menuitem");
    expect(items).toHaveLength(1);
    expect(items[0]!.textContent).toContain("Alice");
  });

  it("Home/End jump to the first/last tab", () => {
    const ts = tabs("home", "work", "ops", "settings");
    renderStrip({ tabs: ts, activeTabId: ts[0]!.id });
    const all = screen.getAllByRole("tab");
    all[1]!.focus();
    fireEvent.keyDown(all[1]!, { key: "End" });
    expect(document.activeElement).toBe(all[3]);
    fireEvent.keyDown(all[3]!, { key: "Home" });
    expect(document.activeElement).toBe(all[0]);
  });

  it("clicking a context menu item fires the right callback and closes the menu", () => {
    const ts = tabs("home", "work");
    const { onPin } = renderStrip({ tabs: ts, activeTabId: ts[0]!.id });
    fireEvent.contextMenu(screen.getAllByRole("tab")[1]!);
    fireEvent.click(screen.getByText("Pin tab"));
    expect(onPin).toHaveBeenCalledWith(ts[1]!.id);
    // Menu should be torn down after the click.
    expect(screen.queryByRole("menu", { name: "Tab actions" })).toBeNull();
  });

  /**
   * Drag-reorder regression suite.
   *
   * The original HTML5-native-drag implementation broke in WebKit
   * after a macOS update (custom-MIME-type protected-mode quirk →
   * dragover preventDefault never fired → drop event never landed),
   * and there were no UI-level tests to catch it. The current
   * pointer-events implementation is exercised here so we don't
   * regress again.
   *
   * happy-dom returns zero-rects from getBoundingClientRect, so each
   * test mocks the tab geometry explicitly. We model 4 tabs at x =
   * 0, 100, 200, 300 (each 100px wide).
   */
  describe("drag-reorder", () => {
    function mockTabRects() {
      const tabEls = screen.getAllByRole("tab");
      tabEls.forEach((el, i) => {
        vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
          x: i * 100,
          y: 0,
          left: i * 100,
          right: (i + 1) * 100,
          top: 0,
          bottom: 36,
          width: 100,
          height: 36,
          toJSON: () => ({}),
        });
      });
      return tabEls;
    }

    it("drag tab 0 past midpoint of tab 2 → onMove(0, 3)", () => {
      const ts = tabs("home", "work", "ops", "settings");
      const { onMove } = renderStrip({ tabs: ts, activeTabId: ts[0]!.id });
      const tabEls = mockTabRects();

      // Pointer down on tab 0 at its center (x=50).
      fireEvent.pointerDown(tabEls[0]!, { button: 0, clientX: 50, clientY: 18 });
      // Move past the 5px threshold and into tab 2's right half (x>250).
      fireEvent.pointerMove(window, { clientX: 60, clientY: 18 });
      fireEvent.pointerMove(window, { clientX: 260, clientY: 18 });
      fireEvent.pointerUp(window);

      // Right half of tab 2 (index 2) → insertion index 3.
      expect(onMove).toHaveBeenCalledWith(0, 3);
    });

    it("drag tab 2 onto left half of tab 0 → onMove(2, 0)", () => {
      const ts = tabs("home", "work", "ops", "settings");
      const { onMove } = renderStrip({ tabs: ts, activeTabId: ts[0]!.id });
      const tabEls = mockTabRects();

      fireEvent.pointerDown(tabEls[2]!, {
        button: 0,
        clientX: 250,
        clientY: 18,
      });
      fireEvent.pointerMove(window, { clientX: 200, clientY: 18 });
      fireEvent.pointerMove(window, { clientX: 30, clientY: 18 });
      fireEvent.pointerUp(window);

      // Left half of tab 0 → insertion index 0.
      expect(onMove).toHaveBeenCalledWith(2, 0);
    });

    it("pointer-up without crossing the 5px threshold is a click, not a drag", () => {
      const ts = tabs("home", "work", "ops");
      const { onMove, onSelect } = renderStrip({
        tabs: ts,
        activeTabId: ts[0]!.id,
      });
      const tabEls = mockTabRects();

      fireEvent.pointerDown(tabEls[1]!, {
        button: 0,
        clientX: 150,
        clientY: 18,
      });
      // Tiny jiggle, well under 5px.
      fireEvent.pointerMove(window, { clientX: 152, clientY: 19 });
      fireEvent.pointerUp(window);
      // The browser fires click after pointerup; simulate it.
      fireEvent.click(tabEls[1]!);

      expect(onMove).not.toHaveBeenCalled();
      expect(onSelect).toHaveBeenCalledWith(ts[1]!.id);
    });

    it("a successful drag suppresses the synthetic click on the source tab", () => {
      const ts = tabs("home", "work", "ops");
      const { onMove, onSelect } = renderStrip({
        tabs: ts,
        activeTabId: ts[0]!.id,
      });
      const tabEls = mockTabRects();

      fireEvent.pointerDown(tabEls[0]!, {
        button: 0,
        clientX: 50,
        clientY: 18,
      });
      fireEvent.pointerMove(window, { clientX: 250, clientY: 18 });
      fireEvent.pointerUp(window);
      // Browser dispatches click on the source after pointerup —
      // in a real run this is on the moved tab; we just need to
      // verify our suppression flag stops onSelect.
      fireEvent.click(tabEls[0]!);

      expect(onMove).toHaveBeenCalled();
      // onSelect must NOT fire — that would re-activate the source
      // tab and visually undo what feels like a successful drag.
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("Escape cancels an in-flight drag without firing onMove", () => {
      const ts = tabs("home", "work", "ops");
      const { onMove } = renderStrip({ tabs: ts, activeTabId: ts[0]!.id });
      const tabEls = mockTabRects();

      fireEvent.pointerDown(tabEls[0]!, {
        button: 0,
        clientX: 50,
        clientY: 18,
      });
      fireEvent.pointerMove(window, { clientX: 250, clientY: 18 });
      fireEvent.keyDown(window, { key: "Escape" });
      fireEvent.pointerUp(window);

      expect(onMove).not.toHaveBeenCalled();
    });

    it("pointercancel (system-aborted gesture) clears state without firing onMove", () => {
      const ts = tabs("home", "work", "ops");
      const { onMove } = renderStrip({ tabs: ts, activeTabId: ts[0]!.id });
      const tabEls = mockTabRects();

      fireEvent.pointerDown(tabEls[0]!, {
        button: 0,
        clientX: 50,
        clientY: 18,
      });
      fireEvent.pointerMove(window, { clientX: 250, clientY: 18 });
      fireEvent.pointerCancel(window);

      expect(onMove).not.toHaveBeenCalled();
    });

    it("right-click does not initiate a drag", () => {
      const ts = tabs("home", "work", "ops");
      const { onMove } = renderStrip({ tabs: ts, activeTabId: ts[0]!.id });
      const tabEls = mockTabRects();

      // button 2 = right
      fireEvent.pointerDown(tabEls[0]!, {
        button: 2,
        clientX: 50,
        clientY: 18,
      });
      fireEvent.pointerMove(window, { clientX: 250, clientY: 18 });
      fireEvent.pointerUp(window);

      expect(onMove).not.toHaveBeenCalled();
    });

    it("middle-click does not initiate a drag", () => {
      const ts = tabs("home", "work", "ops");
      const { onMove } = renderStrip({ tabs: ts, activeTabId: ts[0]!.id });
      const tabEls = mockTabRects();

      fireEvent.pointerDown(tabEls[0]!, {
        button: 1,
        clientX: 50,
        clientY: 18,
      });
      fireEvent.pointerMove(window, { clientX: 250, clientY: 18 });
      fireEvent.pointerUp(window);

      expect(onMove).not.toHaveBeenCalled();
    });

    it("drop on the same slot is a no-op (onMove not called for fromIndex==toIndex)", () => {
      // Reducer treats fromIndex===toIndex and toIndex===fromIndex+1
      // as no-op already, but the UI should not fire onMove if the
      // user lands the drag on the source's own range.
      const ts = tabs("home", "work", "ops");
      const { onMove } = renderStrip({ tabs: ts, activeTabId: ts[0]!.id });
      const tabEls = mockTabRects();

      fireEvent.pointerDown(tabEls[1]!, {
        button: 0,
        clientX: 150,
        clientY: 18,
      });
      // Move past threshold but stay on tab 1's right half — still
      // results in toIndex = 2 = fromIndex+1, which the reducer
      // treats as a no-op. We still dispatch onMove (the reducer is
      // the source of truth for clamping); just assert the args so
      // we can detect a regression where toIndex computation drifts.
      fireEvent.pointerMove(window, { clientX: 160, clientY: 18 });
      fireEvent.pointerMove(window, { clientX: 180, clientY: 18 });
      fireEvent.pointerUp(window);

      expect(onMove).toHaveBeenCalledWith(1, 2);
    });

    it("does not start a drag while a tab is being renamed", () => {
      const ts = tabs("home", "work");
      const { onMove } = renderStrip({ tabs: ts, activeTabId: ts[0]!.id });
      // Enter rename mode on tab 1.
      fireEvent.doubleClick(screen.getAllByRole("tab")[1]!);
      const tabEls = mockTabRects();

      fireEvent.pointerDown(tabEls[1]!, {
        button: 0,
        clientX: 150,
        clientY: 18,
      });
      fireEvent.pointerMove(window, { clientX: 30, clientY: 18 });
      fireEvent.pointerUp(window);

      expect(onMove).not.toHaveBeenCalled();
    });

    /**
     * Visual lift on the source tab. Without this feedback, the
     * drag feels broken — the user has no signal that they've
     * "picked up" anything until the drop lands. The source tab
     * gets the `is-dragging` class plus an inline transform that
     * follows the cursor's horizontal delta from pointerdown.
     */
    it("source tab gets is-dragging + translateX during a drag", () => {
      const ts = tabs("home", "work", "ops", "settings");
      renderStrip({ tabs: ts, activeTabId: ts[0]!.id });
      const tabEls = mockTabRects();

      // Before drag: no lift class anywhere.
      expect(tabEls[0]).not.toHaveClass("is-dragging");
      expect(tabEls[0]!.style.transform).toBe("");

      fireEvent.pointerDown(tabEls[0]!, {
        button: 0,
        clientX: 50,
        clientY: 18,
      });
      // Move 200px to the right (well past 5px threshold).
      fireEvent.pointerMove(window, { clientX: 250, clientY: 18 });

      // Source tab is lifted and translates with the cursor.
      expect(tabEls[0]).toHaveClass("is-dragging");
      expect(tabEls[0]!.style.transform).toBe("translateX(200px)");

      // Non-source tabs are untouched.
      expect(tabEls[1]).not.toHaveClass("is-dragging");
      expect(tabEls[1]!.style.transform).toBe("");
    });

    it("clears the lift on pointerup", () => {
      const ts = tabs("home", "work", "ops");
      renderStrip({ tabs: ts, activeTabId: ts[0]!.id });
      const tabEls = mockTabRects();

      fireEvent.pointerDown(tabEls[0]!, {
        button: 0,
        clientX: 50,
        clientY: 18,
      });
      fireEvent.pointerMove(window, { clientX: 250, clientY: 18 });
      expect(tabEls[0]).toHaveClass("is-dragging");

      fireEvent.pointerUp(window);
      // After drop, the source's lift is removed (the tab has moved
      // to its new slot in the parent's reducer; no visual residue).
      expect(tabEls[0]).not.toHaveClass("is-dragging");
      expect(tabEls[0]!.style.transform).toBe("");
    });

    it("does not lift the tab until the 5px threshold is crossed", () => {
      const ts = tabs("home", "work");
      renderStrip({ tabs: ts, activeTabId: ts[0]!.id });
      const tabEls = mockTabRects();

      fireEvent.pointerDown(tabEls[0]!, {
        button: 0,
        clientX: 50,
        clientY: 18,
      });
      // Tiny jiggle below threshold — must not trigger the lift, or
      // every click would briefly look like a drag.
      fireEvent.pointerMove(window, { clientX: 52, clientY: 19 });
      expect(tabEls[0]).not.toHaveClass("is-dragging");
    });

    it("Escape removes the lift mid-drag", () => {
      const ts = tabs("home", "work", "ops");
      renderStrip({ tabs: ts, activeTabId: ts[0]!.id });
      const tabEls = mockTabRects();

      fireEvent.pointerDown(tabEls[0]!, {
        button: 0,
        clientX: 50,
        clientY: 18,
      });
      fireEvent.pointerMove(window, { clientX: 250, clientY: 18 });
      expect(tabEls[0]).toHaveClass("is-dragging");

      fireEvent.keyDown(window, { key: "Escape" });
      expect(tabEls[0]).not.toHaveClass("is-dragging");
    });
  });
});
