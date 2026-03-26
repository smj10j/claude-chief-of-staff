# Publish to Google Doc

Render a markdown file from the work-agent repo into a properly formatted Google Doc for mobile reading.
Uses a local Node.js script to generate the Apps Script payload, then sends it via `code_file` for near-instant publishing.

## Usage

```
/publish-to-gdoc <file-path> [google-doc-url]
```

- `file-path`: Path to the markdown file (relative to repo root or absolute)
- `google-doc-url` (optional): URL of an existing Google Doc to update in-place (same URL preserved).

## Arguments

The argument string is: $ARGUMENTS

Parse it as: first token is the file path, second token (if present) is a Google Doc URL.

## Workflow

### Step 1 - Generate the payload

Run the local script to write the Apps Script payload to a temp file:

```bash
node bin/md-to-gdoc-payload.js <file-path> > /tmp/gdoc-payload.js
```

This script:
- Reads the markdown file
- Strips `---` horizontal rules, `NOTE:` annotations
- Replaces em dashes with hyphens
- Parses markdown into JSON blocks (headings, paragraphs, bullets, numbers, tables, inline bold/italic/links)
- Embeds the JSON blocks into the fixed renderer script
- Outputs the complete Apps Script code to stdout

### Step 2 - Create or target the doc

**If no URL provided:** Create a new doc:
```javascript
var newDoc = DocumentApp.create('Doc Title');
return { id: newDoc.getId(), url: newDoc.getUrl() };
```
Use the H1 heading text (or filename) as the title.

**If URL provided:** Extract the doc ID from the URL.

### Step 3 - Execute the payload via code_file

Send the payload using the `code_file` parameter — NOT inline `code`:

```
google_workspace_run_script(
  code_file: "/tmp/gdoc-payload.js",
  file_id: "DOC_ID"
)
```

This reads the script from disk, bypassing Claude's token output entirely. This is what makes it fast.

**IMPORTANT:** Do NOT read the payload file and paste it into the `code` parameter. Always use `code_file`. The whole point is to avoid Claude generating those tokens.

### Step 4 - Return results

1. Report the Google Doc URL
2. Copy the URL to clipboard: `echo -n "URL" | pbcopy`
3. Do NOT read the doc back for verification

## Error Handling

- If the file doesn't exist, the script will error - report to user
- If the Google Doc URL is invalid, tell the user
- If Apps Script execution fails, report the error and suggest trying the legacy approach (generate JSON inline)

## Style Guide

Rules are baked into `bin/md-to-gdoc-payload.js`:
- No horizontal rules
- Hyphens not em dashes
- Bold table header rows
- Inline bold/italic/link parsing
- Spacer paragraphs between content blocks
- `NOTE:` annotations stripped

If the style guide changes, update the script - not this command.

## Rules

- Always use `bin/md-to-gdoc-payload.js` to generate the payload - do NOT generate JSON blocks manually
- Always use `code_file` to send the payload - do NOT inline the code
- Do NOT read the doc back for verification
- After publish, always copy URL to clipboard
