# Publish to Google Doc

Render a markdown file from the work-agent repo into a properly formatted Google Doc for mobile reading.

## Usage

```
/publish-to-gdoc <file-path> [google-doc-url]
```

- `file-path`: Path to the markdown file (relative to repo root or absolute)
- `google-doc-url` (optional): URL of an existing Google Doc to overwrite. If omitted, create a new doc.

## Arguments

The argument string is: $ARGUMENTS

Parse it as: first token is the file path, second token (if present) is a Google Doc URL.

## Workflow

### Step 1 — Read the markdown file

Read the file at the given path. If the path is relative, resolve it from the repo root.

### Step 2 — Read the style guide

Read `google-docs-style-guide.md` from the repo root. Apply all rules from it when generating the Apps Script.

### Step 3 — Parse the markdown into blocks

Mentally parse the markdown into an ordered list of blocks:

| Markdown element | Block type |
|---|---|
| `# H1` | `heading1` |
| `## H2` | `heading2` |
| `### H3` | `heading3` |
| `---` | Skip (no horizontal rules per style guide) |
| Plain paragraph | `paragraph` |
| `- item` / `* item` | `bullet_list` (group consecutive items) |
| `1. item` | `numbered_list` (group consecutive items) |
| `\| col \| col \|` table | `table` |
| `` `code` `` inline | Preserve as plain text in v1 |
| `**bold**` | Inline bold — must be rendered via Apps Script |
| `*italic*` | Inline italic — must be rendered via Apps Script |
| `<br>` or `<br><br>` | Line break within a cell or paragraph |
| `> blockquote` | Italic paragraph |

### Step 4 — Create or prepare the target doc

**If a Google Doc URL was provided:**
1. Extract the doc ID from the URL
2. Clear the doc using `google_docs_edit` with operation `clear`

**If no URL was provided:**
1. Create a new Google Doc using `google_workspace_run_script`:
   ```javascript
   var doc = DocumentApp.create('Doc Title Here');
   return { id: doc.getId(), url: doc.getUrl() };
   ```
2. Use the H1 heading text (or filename) as the doc title

### Step 5 — Generate and execute the Apps Script

Generate a single Apps Script that writes the entire document. This is the core of the command. The script should:

1. Open the doc by ID
2. Get the body
3. Clear any existing content (if not already cleared)
4. Iterate through the parsed blocks and append each one

**Key patterns to use in the script:**

Heading:
```javascript
body.appendParagraph('Section Title').setHeading(DocumentApp.ParagraphHeading.HEADING2);
```

Paragraph with inline bold/italic:
```javascript
var p = body.appendParagraph('');
p.appendText('Regular text ');
p.appendText('bold part').setBold(true);
p.appendText(' more regular text');
```

Blank paragraph spacer (between content paragraphs):
```javascript
body.appendParagraph('');
```

Bullet list item:
```javascript
var li = body.appendListItem('Item text');
li.setGlyphType(DocumentApp.GlyphType.BULLET);
```

Bullet with bold label (e.g., `- **Label:** description`):
```javascript
var li = body.appendListItem('');
li.appendText('Label:').setBold(true);
li.appendText(' description text');
li.setGlyphType(DocumentApp.GlyphType.BULLET);
```

Numbered list with concept pattern (bold title + body on next line):
```javascript
var li = body.appendListItem('');
li.appendText('Concept Title').setBold(true);
li.appendText('\r');
li.appendText('Body text explaining the concept');
li.setGlyphType(DocumentApp.GlyphType.NUMBER);
```

Table:
```javascript
var table = body.appendTable([
  ['Header 1', 'Header 2'],
  ['Cell 1', 'Cell 2']
]);
// Bold the header row
var headerRow = table.getRow(0);
for (var i = 0; i < headerRow.getNumCells(); i++) {
  headerRow.getCell(i).editAsText().setBold(true);
}
```

Table with inline formatting in cells — for cells that contain bold or other formatting, build them after creating the table:
```javascript
var cell = table.getRow(1).getCell(0);
cell.clear();
var p = cell.appendParagraph('');
p.appendText('Bold part').setBold(true);
p.appendText(' regular part');
```

Italic paragraph (for blockquotes or callouts):
```javascript
body.appendParagraph('Side note text here').setItalic(true);
```

**Rules to apply in the script:**
- Add a blank paragraph (`body.appendParagraph('')`) between content paragraphs
- NO horizontal rules — skip `---` entirely
- Hyphens (`-`) not em dashes — replace any `—` with ` - `
- Bold labels only, not body text
- H1 for the doc title (first heading), H2 for sections, H3 for subsections
- Bold table header rows

**Script size management:**
- If the markdown is very long, the script may exceed Apps Script limits
- In that case, split into multiple script executions: first creates the doc structure, subsequent ones append remaining content
- Each script chunk should target the same doc ID

Execute the script using `google_workspace_run_script`. The script should return the doc URL.

### Step 6 — Verify and return

1. Read the doc back using `google_docs_read` to verify it rendered correctly
2. Report the Google Doc URL to the user
3. Offer to copy the URL to clipboard via `pbcopy`

If re-publishing (URL was provided), confirm the doc was updated and the URL is unchanged.

## Style Guide Quick Reference

These rules come from `google-docs-style-guide.md` — always follow them:

- **No horizontal rules** between sections
- **Blank paragraph** between every content paragraph
- **Bold labels only** — not body text, not entire paragraphs
- **Hyphens** (`-`) not em dashes (`—`) in Google Docs
- **Italic** for callout/side-note paragraphs
- **Table headers** get bold
- **Concept lists**: bold title + `\r` + body text
- **Step lists**: plain single-line items, no bold

## Error Handling

- If the file doesn't exist, tell the user and exit
- If the Google Doc URL is invalid or inaccessible, tell the user and exit
- If Apps Script execution fails (e.g., size limit), try splitting into chunks
- If the doc can't be created, suggest the user create one manually and pass the URL

## Rules

- Always read `google-docs-style-guide.md` before generating the script — it may have been updated
- Strip any `NOTE:` annotations or internal-only comments from the markdown before publishing (lines that start with `NOTE:` inside blockquotes or indented blocks are internal working notes, not for the published doc)
- Keep the Google Doc title clean — use the H1 heading text, not the filename
- After successful publish, tell the user the URL and offer clipboard copy
