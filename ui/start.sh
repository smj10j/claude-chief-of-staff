#!/bin/bash
# Manage the Chief of Staff UI server.
# Usage: start.sh [start|stop]
#   start (default) - install deps, build, start server, wait for ready, open browser
#   stop            - kill the server if running

set -e
cd "$(dirname "$0")"

PORT=3737

# ── Auto-switch to correct Node version via nvm ──
# Sources nvm if available and switches to the version in .nvmrc.
# If nvm isn't installed, falls through to the version check below.
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
  nvm use --silent 2>/dev/null || nvm install --silent 2>/dev/null
elif [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  . "$NVM_DIR/nvm.sh"
  nvm use --silent 2>/dev/null || nvm install --silent 2>/dev/null
fi

# Require Node 22+
NODE_MAJOR=$(node -v 2>/dev/null | sed 's/v\([0-9]*\).*/\1/')
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 22 ]; then
  echo ""
  echo "  Error: Node.js 22+ is required (found: $(node -v 2>/dev/null || echo 'none'))"
  echo ""
  echo "  If you use nvm:"
  echo "    nvm install 22"
  echo "    nvm use 22"
  echo ""
  echo "  The .nvmrc file in the repo root will auto-select the right version."
  echo ""
  exit 1
fi

# ── Stop ──
if [ "${1:-start}" = "stop" ]; then
  PIDS=$(lsof -ti:$PORT 2>/dev/null || true)
  if [ -n "$PIDS" ]; then
    echo "$PIDS" | xargs kill 2>/dev/null || true
    echo "UI server stopped."
  else
    echo "UI server wasn't running."
  fi
  exit 0
fi

# ── Start ──

# If already running, just open the browser
if curl -s http://localhost:$PORT/ > /dev/null 2>&1; then
  echo "UI server already running on port $PORT."
  open "http://localhost:$PORT"
  exit 0
fi

# Check if something else is using the port
OTHER_PID=$(lsof -ti:$PORT 2>/dev/null || true)
if [ -n "$OTHER_PID" ]; then
  echo "Error: port $PORT is in use by another process (PID $OTHER_PID)."
  exit 1
fi

# Install dependencies on first run
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies (first run only)..."
  npm install --silent
fi

# Build the client bundle
node build.js

# Initialize database (runs migrations, auto-migrates from YAML if needed)
node -e "require('../bin/db/task-db.js').initialize()"

# Start server in background
node server.js &
SERVER_PID=$!

# Wait for server to be ready (up to 15 seconds)
for i in $(seq 1 30); do
  if curl -s http://localhost:$PORT/ > /dev/null 2>&1; then
    echo "UI server running at http://localhost:$PORT (PID $SERVER_PID)"
    open "http://localhost:$PORT"
    # Detach - server continues after script exits
    disown $SERVER_PID 2>/dev/null || true
    exit 0
  fi
  sleep 0.5
done

echo "Error: server did not start within 15 seconds."
kill $SERVER_PID 2>/dev/null || true
exit 1
