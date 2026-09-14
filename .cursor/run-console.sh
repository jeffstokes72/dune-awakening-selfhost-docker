#!/usr/bin/env bash
# Runs the Dune Docker Console API in mock mode, serving the built web UI.
# Mock mode lets the console run without a real Dune game server, so every
# panel renders against placeholder data. Set ADMIN_MOCK_MODE=0 to talk to a
# real stack instead.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT/console/api"

export ADMIN_MOCK_MODE="${ADMIN_MOCK_MODE:-1}"
export ADMIN_AUTH_DISABLED="${ADMIN_AUTH_DISABLED:-1}"
export ADMIN_BIND_HOST="${ADMIN_BIND_HOST:-0.0.0.0}"
export ADMIN_BIND_PORT="${ADMIN_BIND_PORT:-8088}"
export DUNE_DOCKER_DIR="${DUNE_DOCKER_DIR:-$REPO_ROOT}"
export ADMIN_STATIC_DIR="${ADMIN_STATIC_DIR:-$REPO_ROOT/console/web/dist}"

exec node src/server.js
