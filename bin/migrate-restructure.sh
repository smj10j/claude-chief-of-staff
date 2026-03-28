#!/usr/bin/env bash
set -euo pipefail

# Migrate from the old flat structure to the new data/ + bin/ layout.
# Safe to run multiple times — skips files that have already moved.
#
# What it does:
#   1. Moves user content files into data/files/
#   2. Moves tooling scripts into bin/db/ (if git didn't already)
#   3. Cleans up empty old directories
#   4. Verifies the new structure
#
# Usage:
#   bash bin/migrate-restructure.sh

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

info()  { printf '\033[0;34m  %s\033[0m\n' "$1"; }
ok()    { printf '\033[0;32m  %s\033[0m\n' "$1"; }
warn()  { printf '\033[0;33m  %s\033[0m\n' "$1"; }
error() { printf '\033[0;31m  %s\033[0m\n' "$1" >&2; }

# --- Pre-flight ---

# Check if migration is needed
needs_migration=false

# Old flat structure: areas/, projects/, archive/ at repo root
[ -d "$ROOT/areas" ] && needs_migration=true
[ -d "$ROOT/projects" ] && needs_migration=true
[ -d "$ROOT/archive" ] && needs_migration=true
# Old tooling location: data/task-cli.sh (not in db/ subfolder)
[ -f "$ROOT/data/task-cli.sh" ] && needs_migration=true
# Root-level GTD files
[ -f "$ROOT/inbox.md" ] && needs_migration=true
[ -f "$ROOT/style-guide.md" ] && needs_migration=true

if [ "$needs_migration" = false ]; then
  ok "Already migrated — nothing to do."
  exit 0
fi

# Warn about uncommitted changes
if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
  warn "You have uncommitted changes. The migration will move files but won't commit."
  warn "Review the changes and commit when you're satisfied."
  echo ""
fi

info "Migrating to new directory structure..."
echo ""

moved=0
skipped=0

# Helper: move a file/directory, creating parent dirs as needed
move_item() {
  local src="$1" dst="$2"
  if [ ! -e "$src" ]; then
    return
  fi
  if [ -e "$dst" ]; then
    # Destination exists — merge directories, skip existing files
    if [ -d "$src" ] && [ -d "$dst" ]; then
      # Merge: move contents of src into dst
      for item in "$src"/*  "$src"/.*; do
        [ -e "$item" ] || continue
        local base="$(basename "$item")"
        [ "$base" = "." ] || [ "$base" = ".." ] && continue
        if [ ! -e "$dst/$base" ]; then
          mv "$item" "$dst/$base"
          ((moved++)) || true
        else
          ((skipped++)) || true
        fi
      done
      # Remove src if now empty
      rmdir "$src" 2>/dev/null || true
    else
      ((skipped++)) || true
    fi
    return
  fi
  mkdir -p "$(dirname "$dst")"
  mv "$src" "$dst"
  ((moved++)) || true
}

# --- Step 1: Move user content to data/files/ ---

info "Moving user content to data/files/..."

mkdir -p "$ROOT/data/files"

# Directories
move_item "$ROOT/areas"    "$ROOT/data/files/areas"
move_item "$ROOT/projects" "$ROOT/data/files/projects"
move_item "$ROOT/archive"  "$ROOT/data/files/archive"

# Root-level files
for f in inbox.md someday-maybe.md waiting-for.md reading-list.md \
         style-guide.md google-docs-style-guide.md \
         recurring.yaml tasks.yaml tasks-archive.yaml \
         recurring.yaml.bak tasks.yaml.bak tasks-archive.yaml.bak; do
  move_item "$ROOT/$f" "$ROOT/data/files/$f"
done

# --- Step 2: Move tooling to bin/db/ ---

info "Moving tooling scripts to bin/db/..."

mkdir -p "$ROOT/bin/db"

# From data/ root (pre-restructure layout)
for f in task-cli.sh task-cli.js task-db.js; do
  move_item "$ROOT/data/$f" "$ROOT/bin/db/$f"
done
move_item "$ROOT/data/migrations" "$ROOT/bin/db/migrations"
move_item "$ROOT/data/tests"      "$ROOT/bin/db/tests"

# From data/db/ (partially-restructured layout)
for f in task-cli.sh task-cli.js task-db.js; do
  move_item "$ROOT/data/db/$f" "$ROOT/bin/db/$f"
done
move_item "$ROOT/data/db/migrations" "$ROOT/bin/db/migrations"
move_item "$ROOT/data/db/tests"      "$ROOT/bin/db/tests"
# Clean up empty data/db/ if it exists
rmdir "$ROOT/data/db" 2>/dev/null || true

# --- Step 3: Verify ---

echo ""
info "Verifying new structure..."

errors=0
verify() {
  if [ ! -e "$1" ]; then
    error "MISSING: $1"
    ((errors++)) || true
  fi
}

verify "$ROOT/bin/db/task-cli.sh"
verify "$ROOT/bin/db/task-cli.js"
verify "$ROOT/bin/db/task-db.js"
verify "$ROOT/bin/db/migrations"
verify "$ROOT/data/files/areas"
verify "$ROOT/data/files/projects"

if [ "$errors" -gt 0 ]; then
  echo ""
  error "$errors verification errors. Check the output above."
  exit 1
fi

# --- Summary ---

echo ""
ok "Migration complete!"
info "  Files moved:   $moved"
info "  Already there: $skipped"
echo ""
info "Next steps:"
info "  1. Review changes:  git status"
info "  2. Commit:          git add -A && git commit -m 'Migrate to new directory structure'"
echo ""
