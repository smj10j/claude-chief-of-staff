/**
 * Pull the most-likely conference URL out of a calendar event's
 * description text. Order matters: Zoom first because We host the
 * vast majority of User's meetings on Zoom; then Google Meet, MS
 * Teams, Webex, generic patterns.
 *
 * Returns the URL with surrounding HTML or punctuation stripped, or
 * null if no recognizable link is present.
 */
export function extractConferenceLink(
  description: string | null | undefined,
): { kind: string; url: string } | null {
  if (!description) return null;
  // Decode HTML entities that appear in Google Calendar event bodies
  // before regex matching — `&amp;` shows up in Zoom join URLs.
  const text = description
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');

  const patterns: Array<{ kind: string; re: RegExp }> = [
    {
      kind: "Zoom",
      // <subdomain>.zoom.us/j/<digits>?... or zoom.us/my/<id>
      re: /https?:\/\/(?:[\w-]+\.)?zoom\.us\/(?:j|my|w)\/[^\s"'<>]+/,
    },
    {
      kind: "Google Meet",
      re: /https?:\/\/meet\.google\.com\/[\w-]+(?:\?[^\s"'<>]*)?/,
    },
    {
      kind: "Microsoft Teams",
      re: /https?:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s"'<>]+/,
    },
    {
      kind: "Webex",
      re: /https?:\/\/[\w-]+\.webex\.com\/(?:meet|join|webappng)\/[^\s"'<>]+/,
    },
  ];

  for (const { kind, re } of patterns) {
    const m = re.exec(text);
    if (m) return { kind, url: m[0] };
  }
  return null;
}

/**
 * Strip HTML tags and entity-decode for human-readable rendering of an
 * event description. We don't trust the source enough to render the
 * markup; Google Calendar emits a mix of <a>, <br>, and prose that
 * doesn't combine well with our markdown editor styling.
 */
export function plainDescription(
  description: string | null | undefined,
): string {
  if (!description) return "";
  return description
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&nbsp;/g, " ")
    .trim();
}
