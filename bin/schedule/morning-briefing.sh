#!/bin/bash
# morning-briefing.sh — Run /morning-briefing automatically.
#
# Invoked by the launchd agent installed via `cos schedule install`.
# Cleans the env to a known PATH and shells out to `claude --print`
# with the slash command.
#
# The output of /morning-briefing is a SAVED:<path> line; the
# briefing file lives in data/files/areas/daily-briefings/sessions/.
# After this script runs the desktop app picks up the new file on
# next refresh of Home; tauri-plugin-notification fires nothing here
# because that's a Tauri runtime concern, not a launchd one.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COS_DIR="${COS_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
LOG_DIR="$COS_DIR/data/logs"
mkdir -p "$LOG_DIR"

# Resolve claude binary the same way `cos` does.
resolve_claude() {
  if [ -n "${CLAUDE_BIN:-}" ] && [ -x "$CLAUDE_BIN" ]; then
    echo "$CLAUDE_BIN"; return 0
  fi
  if command -v claude >/dev/null 2>&1; then
    command -v claude; return 0
  fi
  for c in "$HOME/.claude/local/claude" /opt/homebrew/bin/claude /usr/local/bin/claude "$HOME/.local/bin/claude"; do
    if [ -x "$c" ]; then echo "$c"; return 0; fi
  done
  return 1
}

if ! claude_bin=$(resolve_claude); then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ERROR claude binary not found" >&2
  exit 1
fi

cd "$COS_DIR"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) START morning-briefing"
echo "/morning-briefing" | "$claude_bin" --print --permission-mode auto --model opus
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) END morning-briefing"
