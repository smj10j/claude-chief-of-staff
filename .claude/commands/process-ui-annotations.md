---
description: Process UI annotations for a file - reads annotations left in the Chief of Staff UI and acts on each one
---

# Process UI Annotations

Process annotations left on a markdown file via the Chief of Staff web UI. Each annotation highlights a section of text with an instruction about what Claude should do (rewrite, expand, research, restructure, etc.).

## Arguments

$ARGUMENTS — The relative file path to process (e.g., `areas/one-on-ones/direct-reports/alice/sessions/2026-03-24.md`). If no argument is provided, list all files with pending annotations and ask the user which to process.

## Steps

1. **If no file path provided**: Read the annotations index to find all files with annotations.
   - Read files from `ui/.annotations/` directory
   - List each file with its annotation count
   - Ask the user which file to process, then continue with that file

2. **Read the annotations** for the specified file:
   - The annotation file is at `ui/.annotations/<encoded-path>.json` where slashes in the path are replaced with `--`
   - Each annotation has: `id`, `text` (the highlighted text), `comment` (the user's instruction), `textBefore`/`textAfter` (surrounding context), `createdAt`
   - Read and display the annotations so we know what we're working with

3. **Read the target markdown file** to understand the full document context.

4. **Process each annotation** according to its `comment` instruction:
   - The `text` field tells you what section/text the annotation is attached to
   - The `comment` field tells you what the user wants done
   - Use `textBefore`/`textAfter` for additional context about where in the document the annotation sits
   - Common instructions: rewrite a section, add detail, restructure, research and fill in, clean up, summarize, etc.
   - Apply changes directly to the file using the Edit tool
   - If an annotation requires research (e.g., "pull in context from Slack"), use available MCP tools (Glean, Google Workspace, etc.) to gather the information first

5. **Clear the processed annotations**:
   - Delete the annotation file at `ui/.annotations/<encoded-path>.json`
   - This signals to the UI that processing is complete

6. **Summary**: Briefly describe what was done for each annotation.

## Important

- Process annotations in document order (top to bottom) to avoid position drift from earlier edits affecting later ones
- If an annotation instruction is ambiguous, make your best judgment — the user can always undo via git
- Respect the document's existing style and tone (consult `style-guide.md` if it's a comms draft)
- Do NOT modify parts of the document that aren't covered by an annotation
