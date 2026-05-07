/**
 * Editor-link routing helpers shared between DocEditor (edit mode) and
 * MarkdownView (read mode).
 */

/** Extensions the editor knows how to open inline. Adding a new one
 *  here is the single switch for "the click opens our editor instead
 *  of being treated as a folder shortcut." */
const DOC_EXTS = [".md", ".html"] as const;

/**
 * Normalize an in-app link target to a path the editor can open.
 *
 * Folder-style targets like `projects/leadership-shift/` get bumped
 * to that folder's README.md — matches the project-card / meeting-card
 * routing convention so the user lands on the canonical doc, not a
 * 404 for a "directory file".
 */
export function ensureDocPath(p: string): string {
  if (!p) return p;
  if (DOC_EXTS.some((ext) => p.endsWith(ext))) return p;
  return p.replace(/\/$/, "") + "/README.md";
}
