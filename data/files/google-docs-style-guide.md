# Google Docs Formatting Style Guide

Reference for Claude when creating or editing Google Docs on your behalf via Apps Script.

## Document Structure

### Title Block

- H1 heading for the document title.
- Single byline paragraph below: `Author | Date | Audience` separated by pipes. Not italic — just regular text.
- One blank paragraph, then straight into the first H2 section

### Cross-Reference Links

- When a document has companion resources (spreadsheets, slide decks, other docs), add a linked paragraph just before the first H2 heading.
- Format: just the link text as a paragraph (e.g., "Capacity Gantt") — no label prefix like "See also:". Keep it minimal.

### Section Headings

- Use H2 for major sections. H3 for subsections within a section.
- **No horizontal rules between sections.** The heading provides enough visual separation.
- One blank paragraph before each H2 heading (natural spacing)

### Paragraph Spacing

- **Add a blank paragraph between content paragraphs** — this is the primary spacing mechanism. Every substantive paragraph should be followed by an empty paragraph before the next one.
- Exception: "Investment:" and "Useful beyond X:" lines at the end of a section are a tight pair — no blank line between them.
- Exception: Metadata pairs like "Started:" / "Target:" can be a tight pair using `\r` line breaks within the same paragraph.

## Text Formatting

### Bold Usage — Labels Only

- **Bold the label, not the content.** Section-internal labels like "What's the problem.", "What we'd build.", "Investment:" get bold. The body text that follows does not. The label anchors the reader; the content is regular weight.
- **"Useful beyond X:" is NOT bold.** Unlike "Investment:", this softer follow-up line doesn't need the bold anchor. Plain text.
- **List item titles**: Depends on the list type:
  - **Steps/process lists** ("How we'd build it", "How we'd approach it"): plain single-line items, no bold, no `\r` breaks. The numbering is enough.
  - **Component/concept lists** ("Three building blocks", Risks, Other Candidates): bold label + description on one line. The bold anchors the reader within a denser list of distinct items.
- **Don't bold entire paragraphs or long runs of text.** If everything is bold, nothing stands out. Bold is for short structural labels only.

### Italic for Callout/Note Paragraphs

- Use italic for side-note paragraphs that provide additional context or connections (e.g., "Event durability connection. ..."). This visually distinguishes them from the main flow without adding a heading.

### Dashes

- **Use hyphens (**`-`**), not em dashes.** Preferred in Google Docs. This differs from markdown files where em dashes are acceptable.

### Quotes

- Use regular quotation marks for inline quotes. Do not italicize quoted text.
- Exception: if the entire paragraph is a quote attribution, italic is fine.

### Code

- Use Google Docs code block formatting (paragraph style) for code snippets — not just a regular paragraph with monospace font.

## Lists

### Numbered Lists with Descriptions

Two patterns depending on content type:

**Concept/component lists** (e.g., "Three building blocks", "Why Now" reasons):

- Bold the title/label text — it anchors the reader within the list
- Add a line break (`\r` in Apps Script) after the bold title
- Body text follows on the next line within the same list item
- This creates a two-line structure: bold title on top, regular explanation below

**Steps/process lists** (e.g., "How we'd build it", "How we'd approach it"):

- Plain text, single-line items — no bold, no `\r` breaks
- The numbering provides enough structure for sequential steps

### Bullet Lists

- Simple bullet lists (feature lists, short items) — just bullet text, no bold.
- For bullets with a bold label followed by explanation (like risk items), keep it all on one line: bold label, then regular text.

## Tables

- Bold the header row
- Bold the total/summary row if there is one
- Keep tables simple — no merged cells, no excessive formatting
- **Every row keeps all its cells.** An empty cell still occupies a column so the row's column count matches the header — otherwise the table renders misaligned. The markdown-to-gdoc converter preserves empty inner cells (see below); don't drop a trailing/empty cell in the source markdown to "save space."
- **Status-glyph tables** (decision logs and similar): before publishing, verify the legend glyphs (✅ 🟡 ⏸ ♻︎) and any emoji/color render consistently across every row — a mixed or missing glyph reads as a mistake in a shared doc.

## Apps Script Implementation Notes

### Blank paragraph between content

```javascript
body.appendParagraph(''); // blank line for spacing
```

### Numbered list with line break after bold title

```javascript
var li = body.appendListItem('');
li.appendText('Bold title here').setBold(true);
li.appendText('\r'); // line break within the list item
li.appendText('Body text follows on next line within same item');
li.setGlyphType(DocumentApp.GlyphType.NUMBER);
```

### Hyphens not em dashes

```javascript
// Do this:
p.appendText('The migration is underway - and the rollout plan is being rebuilt');
// Not this:
p.appendText('The migration is underway \u2014 and the rollout plan is being rebuilt');
```

### No horizontal rules

```javascript
// Do NOT do this between sections:
body.appendHorizontalRule();
// Just use the H2 heading — it's enough
```

### HTML entities must be decoded

Markdown files may contain HTML entities (`&gt;`, `&lt;`, `&amp;`, `&quot;`). These MUST be decoded to their actual characters before rendering. Never pass raw entity codes to Google Docs — they will display as literal text.

### Backslash escapes must be stripped

Markdown escapes like `\-`, `\~`, `\#`, `\*` must have the backslash removed. Google Docs should show `-`, `~`, `#`, `*` — not the escaped versions.

### Lists are normal weight by default

Bullet and numbered list items should be **normal weight** (not bold) unless a specific run within the item is explicitly marked bold. Do not apply bold to the entire list item. Only inline `**bold**` markers within the text should produce bold runs.

### Links must render as hyperlinks

Markdown link syntax `[text](url)` must be converted to actual hyperlinks — display text with a clickable URL. Never pass raw markdown link syntax as plain text. This includes links inside bold markers: `[**bold text**](url)` should render as a bold hyperlink, not literal text with asterisks and brackets.

### `<mark>` and other HTML tags must be stripped

Annotation tags like `<mark data-annotation-id="...">text</mark>` from the UI should be stripped, preserving only the inner text.

### Table cells: preserve empty inner cells

When parsing a markdown table row, strip only the outer pipes, then split — keep inner empty cells so every row keeps its column count. Do not `.filter()` out empty cells, or a row with a blank column collapses and misaligns against the header.

```javascript
// Do this — strip outer pipes, then split, keeping empty cells:
const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
// Not this — this drops empty cells and breaks column alignment:
// const cells = trimmed.split('|').map(c => c.trim()).filter(c => c.length > 0);
```

### Internal anchor links resolve to heading bookmarks

A `#anchor` URL passed straight to `setLinkUrl` renders as a broken link, so in-document anchors (`[Points of confusion](#points-of-confusion)`) need special handling:

- **In paragraphs and list items:** each heading gets a bookmark keyed by its GitHub-style slug as it's rendered. `#slug` links are deferred until the whole doc exists, then pointed at `#bookmark=<id>`, so they jump to the heading. A slug with no matching heading stays plain text.
- **In table cells:** `#anchor` links are skipped (display text kept as plain text) — only external links get `setLinkUrl`.

```javascript
if (run.link && run.link.charAt(0) !== '#') cellElem.setLinkUrl(offset, runEnd, run.link);
```

All of this is implemented in `bin/md-to-gdoc-payload.js`. Documented here so it isn't regressed.