#!/bin/bash
# Wrapper that ensures Node 22+ via nvm before running the task CLI.
# Usage: bash bin/db/task-cli.sh <command> [args] [--format compact|json|table]

# Auto-switch Node version via nvm
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
  nvm use --silent 2>/dev/null || nvm install --silent 2>/dev/null
elif [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  . "$NVM_DIR/nvm.sh"
  nvm use --silent 2>/dev/null || nvm install --silent 2>/dev/null
fi

exec node "$(dirname "$0")/task-cli.js" "$@"
