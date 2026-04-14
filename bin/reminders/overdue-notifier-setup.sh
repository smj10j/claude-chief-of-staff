#!/bin/bash
# overdue-notifier-setup.sh — Install or uninstall the daily overdue task notifier.
#
# Usage:
#   bash bin/reminders/overdue-notifier-setup.sh install    # Enable daily notifications
#   bash bin/reminders/overdue-notifier-setup.sh uninstall  # Disable and remove
#   bash bin/reminders/overdue-notifier-setup.sh status     # Check if installed
#
# What it does:
#   - Creates an "New Tasks" list in Apple Reminders (if it doesn't exist)
#   - Installs a macOS launchd agent that runs every morning at 8:00 AM
#   - The agent calls overdue-notifier.sh, which checks the task DB for overdue items
#     and creates Apple Reminders (with alarms) for each one
#   - Tasks are read-only — the notifier never modifies the task database
#
# Prerequisites:
#   - macOS with Apple Reminders
#   - Xcode CLI tools (for Swift compilation): xcode-select --install
#   - Node.js 22+ (for the task CLI)
#   - Grant Reminders access when prompted on first run

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORK_AGENT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
PLIST_NAME="com.work-agent.overdue-notifier"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"
NOTIFIER_SCRIPT="$SCRIPT_DIR/overdue-notifier.sh"
LOG_DIR="$WORK_AGENT_DIR/data/logs"

# Default schedule: 8:00 AM local time. Override with NOTIFIER_HOUR env var.
HOUR="${NOTIFIER_HOUR:-8}"
MINUTE="${NOTIFIER_MINUTE:-0}"

install() {
    echo "Installing overdue task notifier..."

    # Ensure log directory exists
    mkdir -p "$LOG_DIR"

    # Create the Apple Reminders list (the adapter will error if it doesn't exist)
    # We do a test run to trigger compilation and permission prompts
    echo "Testing Reminders adapter (you may be prompted for permission)..."
    REMINDERS_ADD_LIST="New Tasks" "$SCRIPT_DIR/apple-reminders.sh" add "Setup test — safe to delete" --notes "Created during overdue-notifier setup" 2>/dev/null && echo "  Reminders adapter working." || {
        echo "  Warning: Could not create test reminder. You may need to:"
        echo "    1. Run 'xcode-select --install' for Xcode CLI tools"
        echo "    2. Grant Reminders access in System Settings > Privacy & Security > Reminders"
        echo "  Continuing with install — the notifier will retry on next run."
    }

    # Write the launchd plist
    cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_NAME}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${NOTIFIER_SCRIPT}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>WORK_AGENT_DIR</key>
        <string>${WORK_AGENT_DIR}</string>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    </dict>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>${HOUR}</integer>
        <key>Minute</key>
        <integer>${MINUTE}</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/overdue-notifier.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/overdue-notifier.err</string>
    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>
PLIST

    # Load the agent
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    launchctl load "$PLIST_PATH"

    echo ""
    echo "Overdue notifier installed."
    echo "  Schedule: daily at ${HOUR}:$(printf '%02d' $MINUTE) AM"
    echo "  Plist: $PLIST_PATH"
    echo "  Logs: $LOG_DIR/overdue-notifier.log"
    echo "  Reminders list: 'New Tasks'"
    echo ""
    echo "To test now: bash $NOTIFIER_SCRIPT --dry-run"
    echo "To change the time: NOTIFIER_HOUR=9 bash $0 install"
    echo "To uninstall: bash $0 uninstall"
}

uninstall() {
    echo "Uninstalling overdue task notifier..."
    if [ -f "$PLIST_PATH" ]; then
        launchctl unload "$PLIST_PATH" 2>/dev/null || true
        rm "$PLIST_PATH"
        echo "  Removed $PLIST_PATH"
    else
        echo "  No plist found at $PLIST_PATH"
    fi
    echo "  Done. The 'New Tasks' list in Apple Reminders was not removed."
}

status() {
    if [ -f "$PLIST_PATH" ]; then
        echo "Overdue notifier is installed."
        echo "  Plist: $PLIST_PATH"
        if launchctl list | grep -q "$PLIST_NAME"; then
            echo "  Status: loaded"
        else
            echo "  Status: installed but not loaded (run: launchctl load $PLIST_PATH)"
        fi
        # Show schedule from plist
        SCHED_HOUR=$(defaults read "$PLIST_PATH" StartCalendarInterval 2>/dev/null | grep Hour | awk '{print $3}' | tr -d ';' || echo "?")
        SCHED_MIN=$(defaults read "$PLIST_PATH" StartCalendarInterval 2>/dev/null | grep Minute | awk '{print $3}' | tr -d ';' || echo "?")
        echo "  Schedule: daily at ${SCHED_HOUR}:$(printf '%02d' ${SCHED_MIN:-0})"
    else
        echo "Overdue notifier is not installed."
        echo "  Run: bash $0 install"
    fi
}

case "${1:-}" in
    install)  install ;;
    uninstall) uninstall ;;
    status)   status ;;
    *)
        echo "Usage: $0 <install|uninstall|status>"
        echo ""
        echo "  install    Enable daily overdue task notifications via Apple Reminders"
        echo "  uninstall  Disable and remove the scheduled notifier"
        echo "  status     Check if the notifier is installed and running"
        exit 1
        ;;
esac
