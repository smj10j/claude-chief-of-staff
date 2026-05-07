/**
 * Lightweight toast bus. Any surface can `showToast({...})` and a
 * single ToastHost mounted at the Shell renders the queue. Toasts
 * auto-dismiss after `durationMs`; an optional `action` shows a
 * trailing button (e.g., "Undo") that fires its callback then closes.
 *
 * Backed by window CustomEvents so the bus doesn't need React context
 * — surfaces fire from any depth without prop-drilling.
 */

export type ToastAction = {
  label: string;
  onClick: () => void;
};

export type Toast = {
  id: string;
  /** "info" | "success" | "error" — controls tint, not behavior. */
  kind: "info" | "success" | "error";
  text: string;
  /** Optional trailing button. Click closes the toast + fires onClick. */
  action?: ToastAction;
  /** Auto-dismiss after this many ms. Default 5000. Pass 0 to keep
   * the toast until the user clicks dismiss. */
  durationMs?: number;
};

export const TOAST_SHOW_EVENT = "cos:toast-show";
export const TOAST_DISMISS_EVENT = "cos:toast-dismiss";

export function showToast(t: Omit<Toast, "id">): string {
  const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const toast: Toast = { id, ...t };
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<Toast>(TOAST_SHOW_EVENT, { detail: toast }),
    );
  }
  return id;
}

export function dismissToast(id: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<{ id: string }>(TOAST_DISMISS_EVENT, {
      detail: { id },
    }),
  );
}
