#!/bin/bash
# EventKit adapter — delegates to compiled Swift binary.
# On first run, compiles the Swift source and caches the binary.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SWIFT_SRC="$SCRIPT_DIR/eventkit.swift"
BINARY="$SCRIPT_DIR/.eventkit-bin"

if [ ! -f "$BINARY" ] || [ "$SWIFT_SRC" -nt "$BINARY" ]; then
  COMPILE_LOG=$(swiftc -O "$SWIFT_SRC" -o "$BINARY" 2>&1) || {
    echo "Failed to compile eventkit adapter." >&2
    echo "Run 'xcode-select --install' if Xcode CLI tools are missing." >&2
    echo "$COMPILE_LOG" >&2
    exit 1
  }
fi

exec "$BINARY" "$@"
