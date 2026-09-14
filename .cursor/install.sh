#!/usr/bin/env bash
# Idempotent bootstrap for the Dune Docker Console development environment.
# Installs system + Node dependencies, prepares a local PostgreSQL cluster,
# and builds the web console. Safe to run repeatedly.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PGDATA="${DUNE_DEV_PGDATA:-$HOME/.local/share/dune-pgdata}"

log() { printf '\n==> %s\n' "$*"; }

# --- System packages -------------------------------------------------------
# PostgreSQL backs the console API integration tests; age + python3-cryptography
# back the runtime secrets tests. Only touch apt when something is missing so
# reruns stay fast.
need_pkgs=()
command -v psql >/dev/null 2>&1 || need_pkgs+=(postgresql postgresql-client)
command -v age >/dev/null 2>&1 || need_pkgs+=(age)
python3 -c 'from cryptography.hazmat.primitives.ciphers.aead import AESGCM' >/dev/null 2>&1 \
  || need_pkgs+=(python3-cryptography)
command -v nc >/dev/null 2>&1 || need_pkgs+=(netcat-openbsd)

if [ "${#need_pkgs[@]}" -gt 0 ]; then
  log "Installing system packages: ${need_pkgs[*]}"
  sudo env DEBIAN_FRONTEND=noninteractive apt-get update -o Acquire::Retries=3
  sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${need_pkgs[@]}"
fi

PG_BIN="$(dirname "$(ls -1 /usr/lib/postgresql/*/bin/initdb | sort -V | tail -1)")"

# --- PostgreSQL cluster ----------------------------------------------------
# One-time cluster creation lives here (durable state); the per-boot start is
# handled by .cursor/start.sh. Tests connect to 127.0.0.1:15432 as dune/dune.
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  log "Initializing PostgreSQL cluster at $PGDATA"
  mkdir -p "$PGDATA"
  "$PG_BIN/initdb" -D "$PGDATA" -U dune --auth=trust >/dev/null
  {
    echo "port = 15432"
    echo "listen_addresses = '127.0.0.1'"
    echo "unix_socket_directories = '/tmp'"
  } >> "$PGDATA/postgresql.conf"
fi

# --- Node dependencies -----------------------------------------------------
log "Installing console web dependencies"
( cd console/web && npm ci )

log "Installing console API dependencies"
( cd console/api && npm ci )

# --- Web build -------------------------------------------------------------
# The API serves the built SPA from web-dist when ADMIN_STATIC_DIR points here,
# so building now gives a working console straight from the API port.
log "Building console web bundle"
( cd console/web && npm run build )

log "install.sh complete"
