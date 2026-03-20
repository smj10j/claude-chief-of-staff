#!/usr/bin/env bash
set -euo pipefail

# Claude Chief of Staff — one-liner installer
# Usage: curl -fsSL https://raw.githubusercontent.com/smj10j/claude-chief-of-staff/main/install.sh | bash

REPO_URL="https://github.com/smj10j/claude-chief-of-staff.git"
INSTALL_DIR="${CLAUDE_COS_DIR:-$HOME/claude-chief-of-staff}"

info()  { printf '\033[0;34m%s\033[0m\n' "$1"; }
ok()    { printf '\033[0;32m%s\033[0m\n' "$1"; }
warn()  { printf '\033[0;33m%s\033[0m\n' "$1"; }
error() { printf '\033[0;31m%s\033[0m\n' "$1" >&2; }

# --- Pre-flight checks ---

if ! command -v git &>/dev/null; then
  error "git is not installed."
  if [[ "$OSTYPE" == darwin* ]]; then
    info "On macOS, run:  xcode-select --install"
  else
    info "Install git with your package manager (e.g. apt install git, brew install git)"
  fi
  exit 1
fi

if ! command -v claude &>/dev/null; then
  error "Claude Code CLI is not installed."
  info ""
  info "Install it first:"
  info "  npm install -g @anthropic-ai/claude-code"
  info ""
  info "Full instructions: https://docs.anthropic.com/en/docs/claude-code"
  exit 1
fi

# --- Install ---

if [[ -d "$INSTALL_DIR" ]]; then
  warn "Directory already exists: $INSTALL_DIR"
  info "Pulling latest template updates..."
  git -C "$INSTALL_DIR" pull --ff-only origin main 2>/dev/null || {
    warn "Could not auto-update (you may have local changes). Skipping update."
  }
else
  info "Cloning Claude Chief of Staff..."
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

# Detach from template remote so users start fresh
cd "$INSTALL_DIR"
if git remote get-url origin 2>/dev/null | grep -q "smj10j/claude-chief-of-staff"; then
  git remote rename origin template 2>/dev/null || true
fi

ok ""
ok "Installed to $INSTALL_DIR"
info ""
info "To get started:"
info "  cd $INSTALL_DIR"
info "  claude"
info ""
info "Then type:  /init"
info ""
info "Claude will walk you through setting up your role, team,"
info "direct reports, and meetings. Takes about 5 minutes."
