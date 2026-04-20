#!/bin/bash
# weekly-review-setup.sh — Install or uninstall the Friday weekly review automation.
#
# Usage:
#   bash bin/weekly-review/weekly-review-setup.sh install    # Enable Friday 8 PM review
#   bash bin/weekly-review/weekly-review-setup.sh uninstall  # Disable and remove
#   bash bin/weekly-review/weekly-review-setup.sh status     # Check if installed
#
# What it does:
#   - Installs a macOS launchd agent that runs every Friday at 8:00 PM local time
#   - The agent calls weekly-review-runner.sh, which invokes Claude Code CLI
#     with the /weekly-review command in non-interactive mode
#   - Claude runs the full weekly review: task triage, project health, session
#     compaction, and persists output to data/files/areas/weekly-reviews/sessions/
#
# Prerequisites:
#   - Claude Code CLI installed and authenticated (run `claude` to verify)
#   - Node.js 22+ (for the task CLI)
#   - This repo at the expected path
#
# Environment variables:
#   REVIEW_HOUR    — Hour to run (default: 20 = 8 PM)
#   REVIEW_MINUTE  — Minute to run (default: 0)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COS_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
PLIST_NAME="com.chief-of-staff.weekly-review"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"
RUNNER_SCRIPT="$SCRIPT_DIR/weekly-review-runner.sh"
LOG_DIR="$COS_DIR/data/logs"

# Default: Friday at 8:00 PM local time
HOUR="${REVIEW_HOUR:-20}"
MINUTE="${REVIEW_MINUTE:-0}"
# launchd Weekday: 0=Sunday, 5=Friday
WEEKDAY=5

install() {
    echo "Installing weekly review automation..."

    # Ensure scripts are executable
    chmod +x "$RUNNER_SCRIPT"

    # Ensure log directory exists
    mkdir -p "$LOG_DIR"

    # Verify claude binary exists (quick check, does NOT run a session)
    CLAUDE_BIN=""
    for candidate in \
        "$HOME/.claude/local/claude" \
        "$HOME/.local/bin/claude" \
        "/usr/local/bin/claude" \
        "/opt/homebrew/bin/claude" \
        "$(command -v claude 2>/dev/null || true)"; do
        if [ -n "$candidate" ] && [ -x "$candidate" ]; then
            CLAUDE_BIN="$candidate"
            break
        fi
    done
    if [ -n "$CLAUDE_BIN" ]; then
        echo "  Claude Code CLI found: $CLAUDE_BIN"
    else
        echo "  Warning: Claude Code CLI not found on PATH."
        echo "  The weekly review will fail until claude is installed."
        echo "  Install: https://docs.anthropic.com/en/docs/claude-code"
    fi

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
        <string>${RUNNER_SCRIPT}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>COS_DIR</key>
        <string>${COS_DIR}</string>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:${HOME}/.claude/local:${HOME}/.local/bin</string>
        <key>HOME</key>
        <string>${HOME}</string>
    </dict>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Weekday</key>
        <integer>${WEEKDAY}</integer>
        <key>Hour</key>
        <integer>${HOUR}</integer>
        <key>Minute</key>
        <integer>${MINUTE}</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/weekly-review.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/weekly-review.err</string>
    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>
PLIST

    # Load the agent
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    launchctl load "$PLIST_PATH"

    echo ""
    echo "Weekly review automation installed."
    echo "  Schedule: Fridays at ${HOUR}:$(printf '%02d' $MINUTE)"
    echo "  Plist: $PLIST_PATH"
    echo "  Runner: $RUNNER_SCRIPT"
    echo "  Logs: $LOG_DIR/weekly-review.log"
    echo ""
    echo "To test now: bash $RUNNER_SCRIPT"
    echo "To change the time: REVIEW_HOUR=19 bash $0 install"
    echo "To uninstall: bash $0 uninstall"
}

uninstall() {
    echo "Uninstalling weekly review automation..."
    if [ -f "$PLIST_PATH" ]; then
        launchctl unload "$PLIST_PATH" 2>/dev/null || true
        rm "$PLIST_PATH"
        echo "  Removed $PLIST_PATH"
    else
        echo "  No plist found at $PLIST_PATH"
    fi
    echo "  Done."
}

status() {
    if [ -f "$PLIST_PATH" ]; then
        echo "Weekly review automation is installed."
        echo "  Plist: $PLIST_PATH"
        if launchctl list | grep -q "$PLIST_NAME"; then
            echo "  Status: loaded"
        else
            echo "  Status: installed but not loaded (run: launchctl load $PLIST_PATH)"
        fi
        SCHED_HOUR=$(defaults read "$PLIST_PATH" StartCalendarInterval 2>/dev/null | grep Hour | awk '{print $3}' | tr -d ';' || echo "?")
        SCHED_MIN=$(defaults read "$PLIST_PATH" StartCalendarInterval 2>/dev/null | grep Minute | awk '{print $3}' | tr -d ';' || echo "?")
        echo "  Schedule: Fridays at ${SCHED_HOUR}:$(printf '%02d' ${SCHED_MIN:-0})"
        # Show last run log
        if [ -f "$LOG_DIR/weekly-review.log" ]; then
            LAST_LINE=$(tail -1 "$LOG_DIR/weekly-review.log")
            echo "  Last log entry: $LAST_LINE"
        fi
    else
        echo "Weekly review automation is not installed."
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
        echo "  install    Enable Friday weekly review via Claude Code CLI"
        echo "  uninstall  Disable and remove the scheduled review"
        echo "  status     Check if the review automation is installed"
        exit 1
        ;;
esac
