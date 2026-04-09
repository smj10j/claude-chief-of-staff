# Google Docs Formatting Style Guide

Reference for Claude when creating or editing Google Docs on the user's behalf via Apps Script.

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

- **Use hyphens (**`-`**), not em dashes.** This differs from markdown files where em dashes are acceptable.

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
p.appendText('CRP migration is underway - and the evaluation path is being rebuilt');
// Not this:
p.appendText('CRP migration is underway \u2014 and the evaluation path is being rebuilt');
```

### No horizontal rules

```javascript
// Do NOT do this between sections:
body.appendHorizontalRule();
// Just use the H2 heading — it's enough
```
