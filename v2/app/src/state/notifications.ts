import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

/**
 * Native-OS notification wrapper. Uses tauri-plugin-notification to
 * post macOS notifications when long-running skills complete or
 * timed events fire.
 *
 * Idempotent permission check: the first call requests permission,
 * subsequent calls cache the result. If permission is denied, every
 * call is a silent no-op — never throw.
 */

const PREF_KEY = "cos.notifications-enabled.v1";

export function notificationsEnabled(): boolean {
  if (typeof window === "undefined") return false;
  // Default ON; user can flip OFF in Settings.
  const raw = window.localStorage.getItem(PREF_KEY);
  return raw === null ? true : raw === "true";
}

export function setNotificationsEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PREF_KEY, String(enabled));
  } catch {
    /* ignore */
  }
}

let permissionCache: boolean | null = null;

async function ensurePermission(): Promise<boolean> {
  if (permissionCache !== null) return permissionCache;
  try {
    if (await isPermissionGranted()) {
      permissionCache = true;
      return true;
    }
    const result = await requestPermission();
    permissionCache = result === "granted";
    return permissionCache;
  } catch {
    permissionCache = false;
    return false;
  }
}

/**
 * Best-effort notification. Always shows SOMETHING when called:
 *   - If macOS permission is granted: fire a system notification.
 *   - If permission is denied / not yet asked / plugin missing:
 *     fall back to an in-app toast so the user still sees the
 *     completion. The original "silent no-op" path was a UX
 *     footgun — the user clicks Brief me, walks away, comes back,
 *     and there's no signal anywhere that the run finished.
 *
 * Never throws to the caller. Notifications are decoration, not
 * load-bearing — but they should at least be visible.
 */
export async function notify(title: string, body?: string): Promise<void> {
  if (typeof window === "undefined") return;
  if (!notificationsEnabled()) return;

  // Try the native path first. If anything in this chain fails,
  // surface as a toast so the user still gets feedback.
  try {
    if (await ensurePermission()) {
      sendNotification({ title, body });
      return;
    }
  } catch {
    /* fall through to toast */
  }

  // Fallback: in-app toast. Lazy import to keep the toasts module
  // out of the cold-start path for tests that mock notifications.
  try {
    const { showToast } = await import("./toasts");
    showToast({
      kind: "success",
      text: body ? `${title} — ${body}` : title,
      durationMs: 8000,
    });
  } catch {
    /* nothing more we can do — both fallbacks failed */
  }
}

/**
 * Trigger the macOS permission prompt eagerly while the user is
 * actively interacting (e.g., from a Settings click). Tauri's
 * notification permission is most reliably granted in response to
 * a user gesture; deferring until a skill completes async means
 * the prompt may be silently denied. Returns true on grant.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  return ensurePermission();
}
