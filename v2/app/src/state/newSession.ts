import { invoke } from "@tauri-apps/api/core";

/**
 * Local-timezone YYYY-MM-DD. Sessions are dated in the user's wall
 * clock — same convention the morning briefing uses, so a 9 PM CT
 * session lands under today's date instead of UTC tomorrow.
 */
export function todayLocalIsoDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export type NewSessionOutcome = {
  relPath: string | null;
  error: string | null;
};

/**
 * Create a session file under `<owner_rel>/sessions/<date>.md` via the
 * content_create_session IPC. Always returns a result instead of
 * throwing so the caller can render a soft error inline.
 *
 * Date defaults to today (local). Pass a future date if the user
 * wants to pre-populate, e.g. tomorrow's planning meeting.
 */
export async function newSessionForOwner(
  ownerRelPath: string,
  ownerLabel: string,
  date: string = todayLocalIsoDate(),
): Promise<NewSessionOutcome> {
  try {
    const relPath = await invoke<string>("content_create_session", {
      ownerRelPath,
      date,
      ownerLabel,
    });
    return { relPath, error: null };
  } catch (error) {
    return { relPath: null, error: String(error) };
  }
}
