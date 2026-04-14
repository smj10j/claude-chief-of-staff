# Apple Reminders Integration

Bridges the chief-of-staff task database with Apple Reminders for mobile notifications.

## Components

### Core Adapter (`apple-reminders.sh` / `apple-reminders.swift`)

Swift binary that talks to Apple Reminders via EventKit. Auto-compiles on first run.

```bash
# List incomplete reminders (JSON output)
bash bin/reminders/apple-reminders.sh list

# Mark a reminder complete
bash bin/reminders/apple-reminders.sh complete <id>

# Create a new reminder with optional due date and notes
bash bin/reminders/apple-reminders.sh add "Title" --due 2026-04-15 --notes "Details"
bash bin/reminders/apple-reminders.sh add "Title" --due "2026-04-15 09:00"
```

**Configuration:**
- `REMINDERS_LIST` — which Apple Reminders list to read from (default: "New Tasks")
- `REMINDERS_ADD_LIST` — which list to write to (default: same as `REMINDERS_LIST`)

### Overdue Notifier (`overdue-notifier.sh`)

Checks the task database for overdue tasks and creates Apple Reminders (with alarms) for each one. Your phone buzzes, you see what's overdue.

**Key behavior:**
- **Read-only** — never modifies the task database. It only reads tasks and creates reminders.
- **Deduplicates** — tracks which tasks were notified each day in `data/.overdue-notified`. Won't spam you with the same task twice in one day.
- **Self-cleaning** — purges tracking entries older than 7 days.

```bash
# Preview what would be notified
bash bin/reminders/overdue-notifier.sh --dry-run

# Run once (this is what the scheduled agent calls)
bash bin/reminders/overdue-notifier.sh
```

**Configuration:**
- `NOTIFIER_LIST` — which Apple Reminders list to create notifications in (default: "New Tasks")
- `COS_DIR` — path to the chief-of-staff repo (auto-detected)

### Setup Script (`overdue-notifier-setup.sh`)

Installs a macOS `launchd` agent that runs the overdue notifier every morning.

```bash
# Install (daily at 8:00 AM)
bash bin/reminders/overdue-notifier-setup.sh install

# Install with custom time (e.g., 7:30 AM)
NOTIFIER_HOUR=7 NOTIFIER_MINUTE=30 bash bin/reminders/overdue-notifier-setup.sh install

# Check status
bash bin/reminders/overdue-notifier-setup.sh status

# Uninstall
bash bin/reminders/overdue-notifier-setup.sh uninstall
```

**What install does:**
1. Compiles the Swift adapter (if needed)
2. Tests Reminders access (may prompt for permission)
3. Creates a `launchd` plist at `~/Library/LaunchAgents/com.chief-of-staff.overdue-notifier.plist`
4. Loads the agent

**Logs:** `data/logs/overdue-notifier.log` and `data/logs/overdue-notifier.err`

## Prerequisites

- **macOS** with Apple Reminders
- **Xcode CLI tools** — `xcode-select --install`
- **Node.js 22+** — the task CLI requires it
- **Reminders permission** — grant access when prompted (System Settings > Privacy & Security > Reminders)

## How It Fits Together

```
Task DB (cos.db)          Apple Reminders          Your Phone
     |                         |                       |
     |  overdue-notifier.sh    |                       |
     |  (reads tasks)          |                       |
     |------------------------>|  (creates reminders)  |
     |                         |---------------------->|
     |                         |  (push notification)  |
     |                         |                       |
     |  /review-reminders      |                       |
     |<------------------------|  (imports new items)  |
     |  (creates tasks)        |                       |
```

The notifier pushes overdue tasks TO your phone. The `/review-reminders` command pulls captured items FROM your phone into the task database. They work in opposite directions and never conflict.
