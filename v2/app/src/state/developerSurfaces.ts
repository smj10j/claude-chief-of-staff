/**
 * PRD-116 — Console (and other "developer" surfaces) are gated behind
 * a per-user toggle so a manager who doesn't want a power-user
 * surface in their face never sees one. Default: OFF.
 *
 * The toggle controls *visibility* in the sidebar, not capability —
 * the Console surface still mounts on direct nav (Cmd+K → Console)
 * and on `/console` deep links. This matches v1's pattern of
 * "policy-disabled but discoverable" rather than silent removal.
 */

const KEY = "cos.show-developer-surfaces.v1";
const CHANGED_EVENT = "cos:developer-surfaces-changed";

export function readShowDeveloperSurfaces(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(KEY) === "true";
  } catch {
    return false;
  }
}

export function writeShowDeveloperSurfaces(value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, value ? "true" : "false");
    window.dispatchEvent(new CustomEvent(CHANGED_EVENT));
  } catch {
    // private mode — session-only
  }
}

export const DEVELOPER_SURFACES_CHANGED_EVENT = CHANGED_EVENT;
