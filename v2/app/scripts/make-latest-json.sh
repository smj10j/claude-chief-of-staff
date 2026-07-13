#!/usr/bin/env bash
#
# make-latest-json.sh — emit the Tauri updater manifest (latest.json)
# from the most recent signed build, ready to attach to a GitHub Release.
#
# Reads version from tauri.conf.json, signature from the .sig file in
# src-tauri/target/release/bundle/macos/, and prints the manifest to
# stdout (or --out <path>).
#
# Set the release repo with --repo <owner>/<repo> (or the COS_RELEASE_REPO
# env var). This must match the updater endpoint in tauri.conf.json.
#
# Usage:
#     bash scripts/make-latest-json.sh --notes "Bug fixes." --repo <owner>/<repo>
#     bash scripts/make-latest-json.sh --notes "Crash fix" --urgent --repo <owner>/<repo>
#     bash scripts/make-latest-json.sh --notes "..." --out latest.json --repo <owner>/<repo>
#     bash scripts/make-latest-json.sh --notes "..." --version 0.1.2 --repo <owner>/<repo>
#
# Replaces the hand-edit step for the updater manifest.

set -euo pipefail

cd "$(dirname "$0")/.."

NOTES=""
URGENT=0
VERSION=""
REPO="${COS_RELEASE_REPO:-<owner>/<repo>}"
TAG=""
SIG_PATH=""
OUT=""
ARCH="aarch64"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --notes) NOTES="$2"; shift 2 ;;
    --urgent) URGENT=1; shift ;;
    --version) VERSION="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    --sig) SIG_PATH="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --arch) ARCH="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's|^# \?||'
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$NOTES" ]]; then
  echo "error: --notes is required" >&2
  exit 2
fi

if [[ "$REPO" == "<owner>/<repo>" ]]; then
  echo "error: set the release repo with --repo <owner>/<repo> (or COS_RELEASE_REPO)" >&2
  exit 2
fi

if [[ -z "$VERSION" ]]; then
  VERSION="$(node -e "console.log(require('./src-tauri/tauri.conf.json').version)")"
fi

if [[ -z "$TAG" ]]; then
  TAG="v${VERSION}"
fi

if [[ -z "$SIG_PATH" ]]; then
  SIG_PATH="src-tauri/target/release/bundle/macos/Chief of Staff.app.tar.gz.sig"
fi

if [[ ! -f "$SIG_PATH" ]]; then
  echo "error: signature file not found at: $SIG_PATH" >&2
  echo "       run 'npm run tauri build' with TAURI_SIGNING_PRIVATE_KEY set first" >&2
  exit 1
fi

SIGNATURE="$(cat "$SIG_PATH")"

if [[ "$URGENT" == "1" && "$NOTES" != URGENT:* ]]; then
  NOTES="URGENT: ${NOTES}"
fi

PUB_DATE="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

# URL-encode the version'd asset name (spaces only — version is semver, no other special chars).
ASSET_NAME="Chief of Staff_${VERSION}_${ARCH}.app.tar.gz"
ASSET_URL_NAME="${ASSET_NAME// /%20}"
URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET_URL_NAME}"

PLATFORM_KEY="darwin-${ARCH}"

JSON="$(node -e '
const [version, notes, pubDate, platform, signature, url] = process.argv.slice(1);
const manifest = {
  version,
  notes,
  pub_date: pubDate,
  platforms: {
    [platform]: { signature, url }
  }
};
process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");
' "$VERSION" "$NOTES" "$PUB_DATE" "$PLATFORM_KEY" "$SIGNATURE" "$URL")"

if [[ -n "$OUT" ]]; then
  printf '%s' "$JSON" > "$OUT"
  echo "wrote $OUT (version=$VERSION, platform=$PLATFORM_KEY)" >&2
else
  printf '%s' "$JSON"
fi
