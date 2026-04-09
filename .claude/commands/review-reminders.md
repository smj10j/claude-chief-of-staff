# Reminders Import

Import pending items from Apple Reminders into the task database.

## Flow

1. **Fetch reminders**: Run `bash bin/reminders/apple-reminders.sh list`
   - If non-zero exit code: display the error message from stderr and stop. Don't try to parse it.
   - Parse the JSON array from stdout.
   - If empty array: print "No pending reminders in Apple Reminders." and stop.

2. **Display numbered list** with due dates and notes:
   ```
   1. Follow up with Alex on threshold changes
   2. Book dentist appointment (due: Apr 5) - "Re: crown"
   3. Read article on platform engineering
   ```
   Show due dates inline. Show notes in quotes after a dash if present. Flag stale dates (in the past) with a warning.

3. **Ask which to import**: "Which reminders should I import as tasks? (e.g., 1,3 or 'all' or 'none')"

4. **Enrich and import** selected items:

   **For 1-3 items**: propose enrichment for each individually — tags, due date, priority — then confirm.

   **For 4+ items**: propose all enrichments in a single table:
   ```
   I'll import these with the following defaults:

   | # | Reminder | Tags | Due | Priority |
   |---|----------|------|-----|----------|
   | 1 | Follow up with Alex on thresholds | work, xfn | tomorrow | medium |
   | 3 | Read platform engineering article | work | - | low |

   Look right, or any changes?
   ```

   **Tag inference** — use full repo context:
   - Cross-reference names against `data/files/areas/one-on-ones/` (e.g., a name in `xfn/` -> `xfn`, a name in `direct-reports/` -> `work` + team tag)
   - Personal-sounding items (dentist, gym, groceries, filter, passport, LinkedIn) -> `personal`
   - Team/project references -> appropriate team tag
   - Default: `work`

   **Due date handling**:
   - If reminder has a due date, carry it forward to `--due`
   - If time-of-day is present (format `YYYY-MM-DD HH:MM`), include it
   - If date is in the past: flag it — "This was due 2026-03-12. Import with original date, update to today, or no date?"

   **Notes handling**: Display notes alongside the name during enrichment. Consider incorporating into the task title if they add important context.

5. **Execute import** for each confirmed item:
   ```bash
   bash bin/db/task-cli.sh add "<name>" --due "<date>" --tags "<tags>" --priority <priority>
   bash bin/reminders/apple-reminders.sh complete <id>
   ```
   - If `complete` fails (already completed on another device), warn but don't fail the import
   - Confirm: "Imported and completed in Reminders: 'Follow up with Alex...'"

6. **Summary**: List what was imported and what was skipped.

## Rules
- Never auto-import. Always present the list and let the user choose.
- Use stable IDs from the JSON — never match by name.
- Adapter: `apple-reminders` (hardcoded for now).
- List name configured in `bin/reminders/apple-reminders.sh` (default: "New Tasks").
- If iCloud sync seems stale: "If you don't see a recent reminder, open Reminders.app to trigger sync."
