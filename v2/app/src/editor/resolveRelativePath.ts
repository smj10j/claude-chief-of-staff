/**
 * Resolve a relative href like `../peers/aaron/sessions/2026-04-22.md`
 * against the current doc's content-root-relative path. Returns null
 * if the result escapes the content root (`..` past the root) so the
 * caller can ignore the click instead of opening an unrelated file.
 *
 * Used by the editor's link-click handler so internal cross-doc links
 * navigate within the app, mirroring v1's onNavigate flow.
 */
export function resolveRelativePath(
  currentDocRel: string,
  href: string,
): string | null {
  if (!currentDocRel || !href) return null;
  const baseParts = currentDocRel.split("/");
  // Drop the filename — we resolve from the directory.
  baseParts.pop();
  const hrefParts = href.split("/");
  const out: string[] = [...baseParts];
  for (const seg of hrefParts) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null; // escaped root
      out.pop();
      continue;
    }
    out.push(seg);
  }
  if (out.length === 0) return null;
  return out.join("/");
}
