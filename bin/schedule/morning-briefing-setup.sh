#!/bin/bash
# morning-briefing-setup.sh — Install or uninstall the daily morning
# briefing launchd agent. Mirrors bin/reminders/overdue-notifier-setup.sh
# in shape so the user can manage both via similar muscle memory.
#
# Usage:
#   bash bin/schedule/morning-briefing-setup.sh install
#   bash bin/schedule/morning-briefing-setup.sh uninstall
#   bash bin/schedule/morning-briefing-setup.sh status
#
# Schedule defaults to 7:00 AM local time. Override via
# BRIEFING_HOUR / BRIEFING_MINUTE environment variables.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COS_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
PLIST_NAME="com.chief-of-staff.morning-briefing"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"
RUNNER_SCRIPT="$SCRIPT_DIR/morning-briefing.sh"
LOG_DIR="$COS_DIR/data/logs"

HOUR="${BRIEFING_HOUR:-7}"
MINUTE="${BRIEFING_MINUTE:-0}"

# macOS Sonoma+ deprecated `launchctl load`: it returns 0 without
# registering the agent, so `launchctl list | grep` then reports
# "installed but not loaded" forever. Use bootstrap/bootout against
# the user's GUI domain. Falls back to load/unload on older systems
# that don't recognize the modern verbs.
USER_GUI_DOMAIN="gui/$(id -u)"

bootstrap_agent() {
  # Bootout first — idempotent way to clear any prior registration.
  launchctl bootout "$USER_GUI_DOMAIN/$PLIST_NAME" 2>/dev/null || true
  if launchctl bootstrap "$USER_GUI_DOMAIN" "$PLIST_PATH" 2>/dev/null; then
    return 0
  fi
  # Older macOS — fall back to legacy load.
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  launchctl load "$PLIST_PATH"
}

bootout_agent() {
  if launchctl bootout "$USER_GUI_DOMAIN/$PLIST_NAME" 2>/dev/null; then
    return 0
  fi
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
}

is_loaded() {
  # Modern: print succeeds when the service is registered in the
  # user's GUI domain.
  if launchctl print "$USER_GUI_DOMAIN/$PLIST_NAME" >/dev/null 2>&1; then
    return 0
  fi
  # Legacy fallback for older systems.
  launchctl list 2>/dev/null | grep -q "$PLIST_NAME"
}

install() {
  echo "Installing morning briefing scheduler…"
  mkdir -p "$LOG_DIR"
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
    <string>${LOG_DIR}/morning-briefing.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/morning-briefing.err</string>
    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>
PLIST

  bootstrap_agent

  if is_loaded; then
    echo ""
    echo "✓ Morning briefing scheduler installed and loaded."
  else
    echo ""
    echo "⚠ Plist written but agent did NOT load. Try:"
    echo "    launchctl bootstrap $USER_GUI_DOMAIN $PLIST_PATH"
    echo "  Common cause: the plist references a missing script. Confirm"
    echo "    $RUNNER_SCRIPT"
    echo "  exists and is executable."
  fi
  printf "  Schedule: daily at %d:%02d\n" "$HOUR" "$MINUTE"
  echo "  Plist: $PLIST_PATH"
  echo "  Logs: $LOG_DIR/morning-briefing.log"
  echo ""
  echo "To test now:        bash $RUNNER_SCRIPT"
  echo "To change the time: BRIEFING_HOUR=8 bash $0 install"
  echo "To uninstall:       bash $0 uninstall"
}

uninstall() {
  echo "Uninstalling morning briefing scheduler…"
  if [ -f "$PLIST_PATH" ]; then
    bootout_agent
    rm "$PLIST_PATH"
    echo "  Removed $PLIST_PATH"
  else
    echo "  No plist found at $PLIST_PATH"
  fi
}

status() {
  if [ -f "$PLIST_PATH" ]; then
    echo "Morning briefing scheduler is installed."
    echo "  Plist: $PLIST_PATH"
    if is_loaded; then
      echo "  Status: ✓ loaded (will fire at the scheduled time)"
    else
      echo "  Status: ✗ installed but NOT loaded — won't fire."
      echo "  Recover: bash $0 install   (re-bootstraps the agent)"
    fi
    SCHED_HOUR=$(defaults read "$PLIST_PATH" StartCalendarInterval 2>/dev/null \
      | grep Hour | awk '{print $3}' | tr -d ';' || echo "?")
    SCHED_MIN=$(defaults read "$PLIST_PATH" StartCalendarInterval 2>/dev/null \
      | grep Minute | awk '{print $3}' | tr -d ';' || echo "?")
    printf "  Schedule: daily at %s:%02d\n" "$SCHED_HOUR" "${SCHED_MIN:-0}"
  else
    echo "Morning briefing scheduler is not installed."
    echo "  Run: bash $0 install"
  fi
}

case "${1:-}" in
  install)   install ;;
  uninstall) uninstall ;;
  status)    status ;;
  *)
    echo "Usage: $0 <install|uninstall|status>"
    echo ""
    echo "  install    Enable daily /morning-briefing at $HOUR:$(printf '%02d' "$MINUTE")"
    echo "  uninstall  Disable and remove the scheduled briefing"
    echo "  status     Check if the scheduler is installed and running"
    exit 1
    ;;
esac
