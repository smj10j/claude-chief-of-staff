#!/usr/bin/env bash
#
# launch-fresh.sh — boot the bundled Chief of Staff.app with a clean
# slate so you can verify first-launch / onboarding / data-folder
# behavior without nuking your live data.
#
# Implements "Option A" from the verification recipes in
# cos-dev/implementations/installation-rollout.md:
#
#   - Backs up ~/Library/Application Support/com.smj10j.chiefofstaff/
#     so the next launch sees no prior database, no recovery phrase,
#     no claude-cli config, no plugin state.
#   - Points the app at a scratch content root + task DB via the
#     COS_CONTENT_ROOT and COS_V1_DB env vars.
#   - Clears the per-bundle localStorage (first-run-complete flag,
#     theme, tab strip, etc.) by deleting the WebKit profile dir.
#   - Launches the most recently built .app from the terminal so the
#     env vars actually flow through.
#
# Usage:
#     bash scripts/launch-fresh.sh           # interactive — prompts before nuking
#     bash scripts/launch-fresh.sh --yes     # skip the prompt (CI / scripted use)
#     bash scripts/launch-fresh.sh --restore # restore the backed-up state and exit
#
# After you finish testing:
#     bash scripts/launch-fresh.sh --restore
#
# Lives at v2/app/scripts/launch-fresh.sh; the package.json `tauri:fresh`
# script wraps it.

set -euo pipefail

BUNDLE_ID="com.smj10j.chiefofstaff"
APP_SUPPORT="$HOME/Library/Application Support/${BUNDLE_ID}"
APP_SUPPORT_BAK="${APP_SUPPORT}.fresh-bak"
WEBKIT_PROFILE="$HOME/Library/WebKit/${BUNDLE_ID}"
WEBKIT_PROFILE_BAK="${WEBKIT_PROFILE}.fresh-bak"
LOCAL_STORAGE="$HOME/Library/Caches/${BUNDLE_ID}"
LOCAL_STORAGE_BAK="${LOCAL_STORAGE}.fresh-bak"
SCRATCH="${COS_FRESH_SCRATCH:-/tmp/cos-fresh}"

# Resolve which .app to launch. The dev-loop expectation is "test the
# latest build", so the locally-built bundle wins over a stale copy
# the user may have dragged into /Applications/ days ago. Override
# with COS_FRESH_APP=/path/to/Chief\ of\ Staff.app when needed.
REPO_BUILT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/src-tauri/target/release/bundle/macos/Chief of Staff.app"
INSTALLED="/Applications/Chief of Staff.app"

if [[ -n "${COS_FRESH_APP:-}" ]]; then
  APP_PATH="$COS_FRESH_APP"
elif [[ -d "$REPO_BUILT" ]]; then
  APP_PATH="$REPO_BUILT"
else
  APP_PATH="$INSTALLED"
fi

# If /Applications/ has an older build, the user almost never wants
# it — call out the discrepancy so they don't get confused.
if [[ -d "$REPO_BUILT" && -d "$INSTALLED" ]]; then
  if [[ "$REPO_BUILT" -nt "$INSTALLED" ]]; then
    echo "ⓘ  Using locally-built .app (newer than /Applications/ copy)."
    echo "   Drag the .dmg to Applications when you want to install for daily use."
    echo
  fi
fi

usage() {
  sed -n 's/^# \?//p' "$0" | head -32
  exit 1
}

mode="run"
auto_yes=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y) auto_yes=1 ;;
    --restore) mode="restore" ;;
    -h|--help) usage ;;
    *) echo "unknown arg: $arg"; usage ;;
  esac
done

if [[ "$mode" == "restore" ]]; then
  echo "Restoring backed-up state…"
  if [[ -d "$APP_SUPPORT_BAK" ]]; then
    rm -rf "$APP_SUPPORT"
    mv "$APP_SUPPORT_BAK" "$APP_SUPPORT"
    echo "  ✓ $APP_SUPPORT"
  fi
  if [[ -d "$WEBKIT_PROFILE_BAK" ]]; then
    rm -rf "$WEBKIT_PROFILE"
    mv "$WEBKIT_PROFILE_BAK" "$WEBKIT_PROFILE"
    echo "  ✓ $WEBKIT_PROFILE"
  fi
  if [[ -d "$LOCAL_STORAGE_BAK" ]]; then
    rm -rf "$LOCAL_STORAGE"
    mv "$LOCAL_STORAGE_BAK" "$LOCAL_STORAGE"
    echo "  ✓ $LOCAL_STORAGE"
  fi
  echo "Done."
  exit 0
fi

# Sanity: the app has to exist somewhere to launch.
if [[ ! -d "$APP_PATH" ]]; then
  echo "Couldn't find Chief of Staff.app — looked in:"
  echo "  /Applications/Chief of Staff.app"
  echo "  v2/app/src-tauri/target/release/bundle/macos/Chief of Staff.app"
  echo "Build first with: npm run tauri build"
  exit 1
fi

# Make sure no stale backup is sitting around — they'd hide the
# user's real data behind a leftover ".fresh-bak" if we tried to
# back up again. Refuse and tell the user.
for pair in "$APP_SUPPORT $APP_SUPPORT_BAK" "$WEBKIT_PROFILE $WEBKIT_PROFILE_BAK" "$LOCAL_STORAGE $LOCAL_STORAGE_BAK"; do
  read -r live bak <<<"$pair"
  if [[ -d "$bak" ]]; then
    echo "Refusing to overwrite an existing backup at:"
    echo "  $bak"
    echo "Restore first with:  bash $0 --restore"
    exit 1
  fi
done

cat <<EOF
This will move your *live* Chief of Staff state out of the way so
the bundled app boots as if it were a fresh install:

    $APP_SUPPORT
        → $APP_SUPPORT_BAK
    $WEBKIT_PROFILE
        → $WEBKIT_PROFILE_BAK
    $LOCAL_STORAGE
        → $LOCAL_STORAGE_BAK

The app will then launch with COS_CONTENT_ROOT and COS_V1_DB
pointing at $SCRATCH/data/ — your real data folder is untouched.

When you're done testing, run:
    bash $0 --restore

EOF

if [[ "$auto_yes" -ne 1 ]]; then
  read -r -p "Proceed? [y/N] " reply
  if [[ "$reply" != "y" && "$reply" != "Y" ]]; then
    echo "Cancelled."
    exit 0
  fi
fi

# Move live state aside.
[[ -d "$APP_SUPPORT" ]] && mv "$APP_SUPPORT" "$APP_SUPPORT_BAK"
[[ -d "$WEBKIT_PROFILE" ]] && mv "$WEBKIT_PROFILE" "$WEBKIT_PROFILE_BAK"
[[ -d "$LOCAL_STORAGE" ]] && mv "$LOCAL_STORAGE" "$LOCAL_STORAGE_BAK"

# Fresh scratch dir.
mkdir -p "$SCRATCH/data/files"

# Launch. Foreground so the env vars apply and the user can Ctrl+C
# to quit without affecting the backups (those wait for --restore).
echo
echo "Launching from: $APP_PATH"
echo "  COS_CONTENT_ROOT=$SCRATCH/data/files"
echo "  COS_V1_DB=$SCRATCH/data/cos.db"
echo

COS_CONTENT_ROOT="$SCRATCH/data/files" \
  COS_V1_DB="$SCRATCH/data/cos.db" \
  exec "$APP_PATH/Contents/MacOS/cos-app"
