#!/bin/bash
# Apple Reminders adapter — delegates to compiled Swift binary.
# On first run, compiles the Swift source and caches the binary.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SWIFT_SRC="$SCRIPT_DIR/apple-reminders.swift"
BINARY="$SCRIPT_DIR/.apple-reminders-bin"

# Configuration — override via env var or edit here
export REMINDERS_LIST="${REMINDERS_LIST:-New Tasks}"

# Recompile if source is newer than binary
if [ ! -f "$BINARY" ] || [ "$SWIFT_SRC" -nt "$BINARY" ]; then
  COMPILE_LOG=$(swiftc -O "$SWIFT_SRC" -o "$BINARY" 2>&1) || {
    echo "Failed to compile apple-reminders adapter." >&2
    echo "Run 'xcode-select --install' if Xcode CLI tools are missing." >&2
    echo "$COMPILE_LOG" >&2
    exit 1
  }
fi

exec "$BINARY" "$@"
