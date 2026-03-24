#!/bin/bash
# Start the Chief of Staff UI server.
# Installs dependencies and builds on first run, then starts Express.

set -e
cd "$(dirname "$0")"

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies (first run only)..."
  npm install --silent
fi

# Build the client bundle
node build.js

exec node server.js
