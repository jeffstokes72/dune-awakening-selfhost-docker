#!/usr/bin/env bash
# Per-boot startup for the Dune Docker Console development environment.
# Brings up the local PostgreSQL server and seeds mock-mode setup files so the
# console lands directly on the dashboard. Idempotent and safe to re-run.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PGDATA="${DUNE_DEV_PGDATA:-$HOME/.local/share/dune-pgdata}"
PG_BIN="$(dirname "$(ls -1 /usr/lib/postgresql/*/bin/pg_ctl | sort -V | tail -1)")"

log() { printf '\n==> %s\n' "$*"; }

# --- PostgreSQL ------------------------------------------------------------
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "PostgreSQL cluster missing at $PGDATA; run .cursor/install.sh first." >&2
  exit 1
fi

if "$PG_BIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
  log "PostgreSQL already running"
else
  log "Starting PostgreSQL on 127.0.0.1:15432"
  "$PG_BIN/pg_ctl" -D "$PGDATA" -l "$PGDATA/server.log" -w start
fi

# Wait for readiness, then ensure the dune role/database the tests expect.
for _ in $(seq 1 30); do
  "$PG_BIN/pg_isready" -h 127.0.0.1 -p 15432 -U dune >/dev/null 2>&1 && break
  sleep 1
done

psql -h 127.0.0.1 -p 15432 -U dune -d postgres -v ON_ERROR_STOP=1 <<'SQL'
ALTER ROLE dune WITH PASSWORD 'dune' CREATEDB SUPERUSER;
SELECT 'CREATE DATABASE dune OWNER dune'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'dune')\gexec
SQL

# --- Mock-mode setup seed --------------------------------------------------
# In mock mode the console can run without a real Dune game server. Seed the
# three files the setup wizard checks for so a fresh environment opens straight
# on the dashboard. Never overwrites real setup files.
if [ "${ADMIN_MOCK_MODE:-1}" = "1" ]; then
  mkdir -p runtime/generated runtime/secrets
  [ -f .env ] || cat > .env <<'ENVFILE'
DUNE_COMPOSE_PROJECT_NAME=dune-awakening-selfhost-docker
COMPOSE_PROJECT_NAME=dune-awakening-selfhost-docker
ENVFILE
  [ -f runtime/generated/battlegroup.env ] || echo "BATTLEGROUP_ID=mock-battlegroup-dev" > runtime/generated/battlegroup.env
  [ -f runtime/secrets/funcom-token.txt ] || printf 'mock-dev-funcom-token' > runtime/secrets/funcom-token.txt
  chmod 600 runtime/secrets/funcom-token.txt 2>/dev/null || true
fi

log "start.sh complete"
