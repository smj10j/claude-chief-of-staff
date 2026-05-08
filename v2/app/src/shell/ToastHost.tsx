import { useEffect, useState } from "react";

import {
  TOAST_DISMISS_EVENT,
  TOAST_SHOW_EVENT,
  type Toast,
} from "../state/toasts";

/**
 * Mounts at Shell-level. Listens to window events from
 * state/toasts.ts and renders a stack at the bottom-right. Each
 * toast has its own dismiss timer so showing one doesn't reset
 * everyone else's clock.
 *
 * No external deps — this is a 50-line React component pinned in
 * place. PRD-115 doesn't redesign toasts (they don't exist in 115);
 * this is new surface area entirely.
 */
export function ToastHost() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    function onShow(e: Event) {
      const t = (e as CustomEvent<Toast>).detail;
      setToasts((cur) => [...cur, t]);
    }
    function onDismiss(e: Event) {
      const id = (e as CustomEvent<{ id: string }>).detail.id;
      setToasts((cur) => cur.filter((x) => x.id !== id));
    }
    window.addEventListener(TOAST_SHOW_EVENT, onShow);
    window.addEventListener(TOAST_DISMISS_EVENT, onDismiss);
    return () => {
      window.removeEventListener(TOAST_SHOW_EVENT, onShow);
      window.removeEventListener(TOAST_DISMISS_EVENT, onDismiss);
    };
  }, []);

  if (toasts.length === 0) return null;
  return (
    <div className="cos-toast-host" aria-live="polite" role="region">
      {toasts.map((t) => (
        <ToastView
          key={t.id}
          toast={t}
          onClose={() =>
            setToasts((cur) => cur.filter((x) => x.id !== t.id))
          }
        />
      ))}
    </div>
  );
}

function ToastView({
  toast,
  onClose,
}: {
  toast: Toast;
  onClose: () => void;
}) {
  useEffect(() => {
    const ms = toast.durationMs ?? 5000;
    if (ms === 0) return; // sticky — user must dismiss
    const timer = window.setTimeout(onClose, ms);
    return () => window.clearTimeout(timer);
  }, [toast, onClose]);

  return (
    <div className={`cos-toast cos-toast-${toast.kind}`} role="status">
      <span className="cos-toast-text">{toast.text}</span>
      {toast.action && (
        <button
          type="button"
          className="cos-toast-action"
          onClick={() => {
            toast.action?.onClick();
            onClose();
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        className="cos-toast-dismiss"
        onClick={onClose}
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
