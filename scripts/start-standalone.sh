#!/usr/bin/env bash
# Runs the production build (`next build` with output: "standalone") without Docker.
# Usage: PORT=3000 DATA_DIR=./data scripts/start-standalone.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .next/standalone/server.js ]; then
  echo "No standalone build found: run 'npm run build' first." >&2
  exit 1
fi

# The standalone output does not include static assets nor public/: copy them in.
mkdir -p .next/standalone/.next
rm -rf .next/standalone/.next/static .next/standalone/public
cp -R .next/static .next/standalone/.next/static
cp -R public .next/standalone/public

export MIGRATIONS_DIR="${MIGRATIONS_DIR:-$PWD/drizzle}"
export DATA_DIR="$(mkdir -p "${DATA_DIR:-./data}" && cd "${DATA_DIR:-./data}" && pwd)"
export HOSTNAME="${HOSTNAME_BIND:-127.0.0.1}"
export PORT="${PORT:-3000}"
exec node .next/standalone/server.js
