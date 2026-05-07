/**
 * Vertical drag handle for resizable side panels (sidebar + right
 * context panel). Handle sits centered on the column boundary; clicking
 * + dragging adjusts width within [min, max] and the parent persists
 * the result. Direction-aware so the same component works for
 * left-edge and right-edge handles.
 */
export function ResizeHandle({
  width,
  setWidth,
  min,
  max,
  edge,
  ariaLabel,
}: {
  /** Current width of the panel being resized, in px. */
  width: number;
  /** Called with the new width on each pointer move. Caller persists. */
  setWidth: (next: number) => void;
  min: number;
  max: number;
  /** Which edge of the panel the handle sits on. Determines drag
   *  direction: "right" → drag right grows the panel; "left" → drag
   *  left grows the panel. */
  edge: "left" | "right";
  ariaLabel: string;
}) {
  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const sign = edge === "right" ? 1 : -1;
    const onMove = (ev: MouseEvent) => {
      const dx = (ev.clientX - startX) * sign;
      const next = Math.max(min, Math.min(max, startW + dx));
      setWidth(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    // Lock the cursor + suppress text selection for the duration of
    // the drag so dragging across editable areas doesn't snag selection.
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Keyboard step adjustments for accessibility — Left/Right arrows
  // with shift = larger jumps. We expose the handle as role="separator"
  // so AT users can find + adjust it.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const step = e.shiftKey ? 32 : 8;
    const sign = edge === "right" ? 1 : -1;
    const dx = (e.key === "ArrowRight" ? step : -step) * sign;
    const next = Math.max(min, Math.min(max, width + dx));
    if (next !== width) {
      e.preventDefault();
      setWidth(next);
    }
  };

  return (
    <div
      className={`cos-resize-handle cos-resize-handle--${edge}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onMouseDown={onMouseDown}
      onKeyDown={onKeyDown}
    />
  );
}
