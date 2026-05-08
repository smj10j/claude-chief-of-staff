export type OpenDoc = {
  /** Path relative to the content root. */
  relPath: string;
  /** Human-readable label for the *leaf* breadcrumb + doc header. */
  label: string;
  /**
   * Intermediate breadcrumbs between the surface and the leaf. For a 1:1
   * session, this is
   *   `[{ label: "<Person>", profile: { slug, label, rel_path } }]`
   * so the header reads `People › <Person> › 2026-04-20`, and clicking the
   * person crumb navigates to that profile instead of closing the doc.
   * For a project sub-file:
   *   `[{ label: "<Project>", project: { slug, label, rel_path } }]`
   * — crumb click routes to the ProjectDetail view.
   * For a meeting session:
   *   `[{ label: "<Meeting>", meeting: { slug, label, rel_path } }]`
   * — crumb click routes to the MeetingDetail view.
   * Crumbs without a typed target just close the doc when clicked.
   */
  crumbs?: Array<{
    label: string;
    profile?: { slug: string; label: string; rel_path: string };
    project?: { slug: string; label: string; rel_path: string };
    meeting?: { slug: string; label: string; rel_path: string };
  }>;
  /**
   * Optional substring to find + scroll to inside the rendered doc.
   * Used by Home priority cards that fall back to the briefing — the
   * editor jumps to the bulleted line rather than the doc top.
   * Matched case-insensitively, first occurrence wins.
   */
  scrollTo?: string;
};
