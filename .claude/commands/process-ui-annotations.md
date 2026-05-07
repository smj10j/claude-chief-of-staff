---
description: Process UI annotations for a file - reads annotations left next to a markdown file and acts on each one
---

# Process UI Annotations

Process inline annotations dropped on a markdown file (via the Chief of Staff app or any tool that writes the sidecar format). Each annotation highlights a section of text with an instruction about what Claude should do (rewrite, expand, research, restructure, etc.).

## Arguments

$ARGUMENTS — The repo-relative file path to process (e.g., `data/files/areas/one-on-ones/direct-reports/alice/sessions/2026-03-24.md`). If no argument is provided, list all files with pending annotations and ask the user which to process.

## Steps

1. **Locate the annotations sidecar.** Annotations live at `<file-path>.annotations.json` sitting next to the markdown file (e.g., `data/files/areas/.../sessions/2026-03-24.md.annotations.json`).

   If no file path was provided, list every file that has a sidecar and ask which to process. To enumerate candidates: `find data/files -name '*.annotations.json'`.

2. **Read the annotations**. Each entry has: `id`, `text` (the highlighted text), `comment` (the user's instruction), `textBefore`/`textAfter` (surrounding context), `createdAt`, and optionally `processedAt`.

   Skip any annotation whose `processedAt` is already set — those have been applied previously.

3. **Read the target markdown file** to understand the full document context.

4. **Process each annotation** according to its `comment` instruction (in document order):
   - The `text` field tells you what section/text the annotation is attached to
   - The `comment` field tells you what the user wants done
   - Use `textBefore`/`textAfter` to disambiguate when the same text appears multiple times
   - Common instructions: rewrite a section, add detail, restructure, research and fill in, clean up, summarize, etc.
   - Apply changes directly to the file using the Edit tool
   - If an annotation requires research (e.g., "pull in context from Slack"), use available MCP tools (Glean, Google Workspace, slack-local-mcp) to gather the information first

5. **Clear each processed annotation from the sidecar.** Once you apply an annotation's instruction, remove that entry from the JSON array entirely — it's done, it shouldn't linger in the editor. Rewrite the sidecar JSON (`<file>.annotations.json`) with only the annotations you did NOT process. If the result is an empty list, delete the sidecar file. Use the Edit/Write tools directly on the sidecar — do not call any `annotations_*` IPC.

   If you chose to skip an annotation (e.g., the instruction was ambiguous or out of scope), leave it in the array so the user can rephrase and re-run.

6. **Print the structured tail.** End the response with **exactly two final lines**, in this order:

   ```
   PROCESSED: <comma-separated annotation IDs you applied>
   SAVED: <repo-relative-path-to-the-markdown-file>
   ```

   - `PROCESSED:` lists the `id` field of every annotation you applied in step 4. Skipped annotations don't go on this line. Empty list → emit `PROCESSED:` with nothing after the colon.
   - `SAVED:` is the markdown file path.
   - The Chief of Staff app uses `PROCESSED:` as a deterministic safety net — even if step 5's sidecar cleanup didn't land, the backend will scrub these IDs from the JSON. Including them is non-negotiable.
   - The `SAVED:` line must be the LAST line of the response, with no trailing whitespace.

## Important

- Process annotations in document order (top to bottom) to avoid position drift from earlier edits affecting later ones
- If an annotation instruction is ambiguous, make your best judgment — the user can always undo via git
- Respect the document's existing style and tone (consult `data/files/style-guide.md` if it's a comms draft)
- Do NOT modify parts of the document that aren't covered by an annotation
- The `SAVED:` line must be the LAST line of the response, with no trailing whitespace.
