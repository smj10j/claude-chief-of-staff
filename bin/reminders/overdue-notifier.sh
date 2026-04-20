#!/bin/bash
# overdue-notifier.sh — Check for overdue tasks and create Apple Reminders for them.
#
# Reads from the task database (read-only — never modifies tasks).
# Creates reminders in a dedicated Apple Reminders list so they show up as
# phone notifications. Tracks which tasks have already been notified to avoid
# duplicates across runs.
#
# Usage:
#   bash bin/reminders/overdue-notifier.sh          # Run once (cron/launchd calls this)
#   bash bin/reminders/overdue-notifier.sh --dry-run # Preview without creating reminders
#
# Configuration:
#   NOTIFIER_LIST  — Apple Reminders list to write to (default: "Overdue Tasks")
#   COS_DIR — Path to the chief-of-staff repo (default: script's grandparent dir)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COS_DIR="${COS_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
REMINDERS_SH="$SCRIPT_DIR/apple-reminders.sh"
TASK_CLI="$COS_DIR/bin/db/task-cli.sh"
NOTIFIED_FILE="$COS_DIR/data/.overdue-notified"
DRY_RUN=false

if [[ "${1:-}" == "--dry-run" ]]; then
    DRY_RUN=true
fi

# Ensure the notified-tracking file exists
touch "$NOTIFIED_FILE"

# Export the target list for the reminders adapter
export REMINDERS_ADD_LIST="${NOTIFIER_LIST:-New Tasks}"

# Source nvm for Node.js (task-cli needs it)
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Get overdue tasks as JSON
OVERDUE_JSON=$("$TASK_CLI" list --due-by today --format json 2>/dev/null)

if [ -z "$OVERDUE_JSON" ] || [ "$OVERDUE_JSON" = "[]" ]; then
    exit 0
fi

# Fetch existing incomplete reminders so we can update instead of duplicate
EXISTING_REMINDERS=$("$REMINDERS_SH" list 2>/dev/null || echo "[]")

# Process each overdue task
echo "$OVERDUE_JSON" | node -e "
const tasks = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
const now = new Date();
for (const t of tasks) {
    if (!t.isOverdue && t.due && !t.due.includes(' ')) {
        continue;
    }
    if (t.isOverdue || t.due) {
        console.log(JSON.stringify({ id: t.id, title: t.title, due: t.due, priority: t.priority }));
    }
}
" | while IFS= read -r line; do
    TASK_ID=$(echo "$line" | node -e "console.log(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).id)")
    TASK_TITLE=$(echo "$line" | node -e "console.log(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).title)")
    TASK_DUE=$(echo "$line" | node -e "console.log(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).due || '')")
    TASK_PRIORITY=$(echo "$line" | node -e "console.log(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).priority || 'medium')")

    # Skip if already notified today
    TODAY=$(date +%Y-%m-%d)
    if grep -q "^${TASK_ID}|${TODAY}$" "$NOTIFIED_FILE" 2>/dev/null; then
        continue
    fi

    REMINDER_TITLE="[Overdue] $TASK_TITLE"
    NOTES="Priority: $TASK_PRIORITY | Due: $TASK_DUE | Task ID: $TASK_ID"
    DUE_ARGS="--due $(date +%Y-%m-%d) $(date +%H:%M)"

    # Check if a reminder already exists for this task (match by Task ID in notes)
    EXISTING_ID=$(echo "$EXISTING_REMINDERS" | node -e "
        const reminders = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
        const taskId = '$TASK_ID';
        const match = reminders.find(r => r.notes && r.notes.includes('Task ID: ' + taskId));
        if (match) console.log(match.id);
    " 2>/dev/null)

    if $DRY_RUN; then
        if [ -n "$EXISTING_ID" ]; then
            echo "Would update reminder ($EXISTING_ID): $REMINDER_TITLE — due now"
        else
            echo "Would create reminder: $REMINDER_TITLE ($NOTES) [due: $TASK_DUE, priority: high]"
        fi
    else
        if [ -n "$EXISTING_ID" ]; then
            "$REMINDERS_SH" update "$EXISTING_ID" $DUE_ARGS --notes "$NOTES" > /dev/null 2>&1 || true
        else
            "$REMINDERS_SH" add "$REMINDER_TITLE" $DUE_ARGS --priority high --notes "$NOTES" > /dev/null 2>&1 || true
        fi
        echo "${TASK_ID}|${TODAY}" >> "$NOTIFIED_FILE"
    fi
done

# Clean up old tracking entries (keep last 7 days)
if [ -f "$NOTIFIED_FILE" ]; then
    CUTOFF=$(date -v-7d +%Y-%m-%d 2>/dev/null || date -d "7 days ago" +%Y-%m-%d 2>/dev/null || echo "")
    if [ -n "$CUTOFF" ]; then
        awk -F'|' -v cutoff="$CUTOFF" '$2 >= cutoff' "$NOTIFIED_FILE" > "$NOTIFIED_FILE.tmp" && mv "$NOTIFIED_FILE.tmp" "$NOTIFIED_FILE"
    fi
fi
