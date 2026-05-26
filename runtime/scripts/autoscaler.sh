#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

INTERVAL="${DUNE_AUTOSCALER_INTERVAL:-5}"
SINCE="${DUNE_AUTOSCALER_LOG_SINCE:-30s}"
IDLE_SECONDS="${DUNE_AUTOSCALER_IDLE_SECONDS:-300}"
STATE_FILE="${DUNE_AUTOSCALER_STATE_FILE:-runtime/generated/autoscaler-idle.tsv}"
SERVER_ID_MAP_FILE="${DUNE_AUTOSCALER_SERVER_ID_MAP_FILE:-runtime/generated/autoscaler-server-ids.tsv}"

mkdir -p "$(dirname "$STATE_FILE")"
touch "$STATE_FILE"
touch "$SERVER_ID_MAP_FILE"

echo "=== Dune Docker autoscaler ==="
echo "Watching Director travel queues and idle dynamic servers."
echo "Interval: ${INTERVAL}s"
echo "Log window: ${SINCE}"
echo "Idle despawn grace: ${IDLE_SECONDS}s"
echo "State file: ${STATE_FILE}"
echo

if ! docker ps --format '{{.Names}}' | grep -qx dune-director; then
  echo "dune-director is not running."
  exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -qx dune-postgres; then
  echo "dune-postgres is not running."
  exit 1
fi

psql_value() {
  docker exec dune-postgres psql -U postgres -d dune -Atc "$1"
}

map_uses_dedicated_scaling() {
  local map="$1"

  python3 - "$map" <<'PY'
import json
import sys
from pathlib import Path

target = sys.argv[1].lower()
catalog_path = Path("runtime/generated/server-catalog.json")

if not catalog_path.exists():
    print("0")
    raise SystemExit

try:
    catalog = json.loads(catalog_path.read_text())
except Exception:
    print("0")
    raise SystemExit

for item in catalog:
    if str(item.get("map", "")).lower() != target:
        continue
    print("1" if bool((item.get("raw") or {}).get("dedicatedScaling")) else "0")
    raise SystemExit

print("0")
PY
}

map_exists() {
  local map="$1"
  local safe
  safe="$(printf '%s' "$map" | tr -cd 'A-Za-z0-9_')"

  [ "$(psql_value "select count(*) from dune.world_partition where lower(map) = lower('$safe');")" != "0" ]
}

map_assigned_count() {
  local map="$1"
  local safe
  safe="$(printf '%s' "$map" | tr -cd 'A-Za-z0-9_')"

  psql_value "
    select count(*)
    from dune.world_partition
    where lower(map) = lower('$safe')
      and coalesce(server_id, '') <> '';
  "
}

container_count_for_map() {
  local map="$1"
  local safe
  safe="$(echo "$map" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//')"

  docker ps --format '{{.Names}}' | grep -Ec "^dune-server-${safe}-[0-9]+$" || true
}

max_dimensions_for_map() {
  local map="$1"
  local configured

  configured="$(python3 - "$map" <<'PY'
import json
import sys
from pathlib import Path

target = sys.argv[1]
config_path = Path("runtime/generated/sietch-config.json")
if not config_path.exists():
    raise SystemExit
config = json.loads(config_path.read_text())
value = config.get("maps", {}).get(target, {}).get("max_dimensions")
if value:
    print(value)
PY
  )"

  if [ -n "$configured" ]; then
    echo "$configured"
    return 0
  fi

  psql_value "
    select count(*)
    from dune.world_partition
    where lower(map) = lower('${map//\'/\'\'}');
  "
}

state_key() {
  local map="$1"
  local server_id="$2"
  printf '%s|%s' "$map" "$server_id"
}

get_idle_since() {
  local key="$1"
  awk -F '\t' -v key="$key" '$1 == key { print $2; found=1; exit } END { if (!found) exit 1 }' "$STATE_FILE"
}

set_idle_since() {
  local key="$1"
  local ts="$2"
  local tmp
  tmp="$(mktemp)"

  awk -F '\t' -v key="$key" '$1 != key { print }' "$STATE_FILE" > "$tmp"
  printf '%s\t%s\n' "$key" "$ts" >> "$tmp"
  mv "$tmp" "$STATE_FILE"
}

clear_idle_since() {
  local key="$1"
  local tmp
  tmp="$(mktemp)"

  awk -F '\t' -v key="$key" '$1 != key { print }' "$STATE_FILE" > "$tmp"
  mv "$tmp" "$STATE_FILE"
}

remember_server_id_map() {
  local map="$1"
  local server_id="$2"
  local tmp

  [ -n "$map" ] || return 0
  [ -n "$server_id" ] || return 0

  tmp="$(mktemp)"
  awk -F '\t' -v sid="$server_id" '$1 != sid { print }' "$SERVER_ID_MAP_FILE" > "$tmp"
  printf '%s\t%s\n' "$server_id" "$map" >> "$tmp"
  mv "$tmp" "$SERVER_ID_MAP_FILE"
}

map_for_server_id() {
  local server_id="$1"
  awk -F '\t' -v sid="$server_id" '$1 == sid { print $2; found=1; exit } END { if (!found) exit 1 }' "$SERVER_ID_MAP_FILE"
}

assigned_server_for_map() {
  local map="$1"
  local safe
  safe="$(printf '%s' "$map" | tr -cd 'A-Za-z0-9_')"

  psql_value "
    select coalesce(server_id, '')
    from dune.world_partition
    where lower(map) = lower('$safe')
      and coalesce(server_id, '') <> ''
    order by partition_id
    limit 1;
  "
}

partition_target_info() {
  local partition_id="$1"
  psql_value "
    select
      partition_id || '|' ||
      map || '|' ||
      coalesce(dimension_index::text, '0') || '|' ||
      coalesce(server_id, '')
    from dune.world_partition
    where partition_id = $partition_id
    limit 1;
  "
}

survival_fallback_target_info() {
  local home_dimension_index="$1"
  local row

  if [ -n "$home_dimension_index" ] && printf '%s' "$home_dimension_index" | grep -Eq '^[0-9]+$'; then
    row="$(psql_value "
      select
        partition_id || '|' ||
        map || '|' ||
        coalesce(dimension_index::text, '0') || '|' ||
        coalesce(server_id, '')
      from dune.world_partition
      where lower(map) = lower('Survival_1')
        and dimension_index = $home_dimension_index
      order by partition_id
      limit 1;
    ")"
    if [ -n "$row" ]; then
      echo "$row"
      return 0
    fi
  fi

  psql_value "
    select
      partition_id || '|' ||
      map || '|' ||
      coalesce(dimension_index::text, '0') || '|' ||
      coalesce(server_id, '')
    from dune.world_partition
    where lower(map) = lower('Survival_1')
    order by dimension_index, partition_id
    limit 1;
  "
}

handle_demand() {
  local map="$1"
  local num="$2"
  local dedicated_scaling

  case "$map" in
    Survival_1|Overmap)
      return 0
      ;;
  esac

  if ! map_exists "$map"; then
    echo "WARN unknown map from Director travel queue: $map"
    return 0
  fi

  local assigned
  assigned="$(map_assigned_count "$map")"

  local running
  running="$(container_count_for_map "$map")"

  dedicated_scaling="$(map_uses_dedicated_scaling "$map")"

  if [ "$dedicated_scaling" = "1" ]; then
    if [ "$assigned" != "0" ] || [ "$running" != "0" ]; then
      echo "OK   demand map=$map num=$num already running/assigned assigned=$assigned containers=$running"
      return 0
    fi

    echo "SPAWN demand map=$map num=$num"
    runtime/scripts/spawn-server.sh "$map" || {
      echo "ERROR failed to spawn $map"
      return 0
    }
    return 0
  fi

  local max_dimensions
  max_dimensions="$(max_dimensions_for_map "$map")"

  if [ "$assigned" -ge "$max_dimensions" ] 2>/dev/null || [ "$running" -ge "$max_dimensions" ] 2>/dev/null; then
    echo "WAIT demand map=$map num=$num max dimensions reached max=$max_dimensions assigned=$assigned containers=$running"
    return 0
  fi

  if [ "$assigned" != "0" ] || [ "$running" != "0" ]; then
    echo "OK   demand map=$map num=$num already running/assigned assigned=$assigned containers=$running"
    return 0
  fi

  echo "SPAWN demand map=$map num=$num"
  runtime/scripts/spawn-server.sh "$map" || {
    echo "ERROR failed to spawn $map"
    return 0
  }
}

handle_idle_row() {
  local map="$1"
  local server_id="$2"
  local connected_players="$3"
  local effective_players="$4"
  local ready="$5"
  local alive="$6"

  case "$map" in
    Survival_1|Overmap)
      return 0
      ;;
  esac

  local key
  key="$(state_key "$map" "$server_id")"

  if [ "$connected_players" != "0" ] || [ "$effective_players" != "0" ] || [ "$ready" != "t" ] || [ "$alive" != "t" ]; then
    clear_idle_since "$key"
    return 0
  fi

  local now since age
  now="$(date +%s)"

  if since="$(get_idle_since "$key" 2>/dev/null)"; then
    age=$((now - since))
  else
    since="$now"
    age=0
    set_idle_since "$key" "$since"
    echo "IDLE map=$map server=$server_id players=0 effective=0 grace=${IDLE_SECONDS}s"
  fi

  if [ "$age" -ge "$IDLE_SECONDS" ]; then
    echo "DESPAWN idle map=$map server=$server_id idle=${age}s"
    runtime/scripts/despawn-server.sh "$map" || true
    clear_idle_since "$key"
  fi
}

scan_idle_servers() {
  docker exec dune-postgres psql -U postgres -d dune -At -F '|' -c "
    select
      fs.map,
      fs.server_id,
      fs.connected_players,
      coalesce(effective_players, 0) as effective_players,
      fs.ready,
      fs.alive
    from dune.farm_state fs
    left join (
      select
        server_id,
        count(*) filter (
          where online_status <> 'Offline'
             or (
               reconnect_grace_period_end is not null
               and reconnect_grace_period_end > (current_timestamp at time zone 'UTC')
             )
             or (
               last_avatar_activity is not null
               and last_avatar_activity > (current_timestamp - make_interval(secs => ${IDLE_SECONDS}))
             )
        ) as effective_players
      from dune.player_state
      where coalesce(server_id, '') <> ''
      group by server_id
    ) ps on ps.server_id = fs.server_id
    where map not in ('Survival_1', 'Overmap')
      and coalesce(fs.server_id, '') <> ''
    order by map;
  " | while IFS='|' read -r map server_id connected_players effective_players ready alive; do
    [ -z "${map:-}" ] && continue
    remember_server_id_map "$map" "$server_id"
    handle_idle_row "$map" "$server_id" "$connected_players" "$effective_players" "$ready" "$alive"
  done
}

scan_reconnect_demand() {
  docker exec dune-postgres psql -U postgres -d dune -At -F '|' -c "
    select
      ps.account_id,
      coalesce(ps.server_id, ''),
      coalesce(ps.previous_server_partition_id::text, ''),
      coalesce(ps.home_dimension_index::text, '')
    from dune.player_state ps
    left join dune.farm_state fs on fs.server_id = ps.server_id
    where (
        coalesce(ps.server_id, '') <> ''
        and fs.server_id is null
      )
       or (
        coalesce(ps.server_id, '') = ''
        and ps.previous_server_partition_id is not null
      );
  " | while IFS='|' read -r account_id stale_server_id previous_partition_id home_dimension_index; do
    local target_row target_partition_id target_map target_dimension target_server_id running fallback_row old_server_id

    [ -n "${account_id:-}" ] || continue
    old_server_id="$stale_server_id"
    target_row=""

    if [ -n "$previous_partition_id" ]; then
      target_row="$(partition_target_info "$previous_partition_id")"
    fi

    if [ -z "$target_row" ]; then
      target_row="$(survival_fallback_target_info "$home_dimension_index")"
    fi

    [ -n "$target_row" ] || continue
    IFS='|' read -r target_partition_id target_map target_dimension target_server_id <<< "$target_row"
    [ -n "$target_partition_id" ] || continue

    if [ -z "$target_server_id" ]; then
      if [ "$target_map" = "Survival_1" ] || [ "$target_map" = "Overmap" ]; then
        target_row="$(partition_target_info "$target_partition_id")"
        IFS='|' read -r target_partition_id target_map target_dimension target_server_id <<< "$target_row"
      else
        running="$(container_count_for_map "$target_map")"
        if [ "$running" = "0" ]; then
          echo "SPAWN reconnect partition=$target_partition_id map=$target_map account=$account_id"
          runtime/scripts/spawn-server.sh "$target_partition_id" || {
            echo "ERROR failed to spawn reconnect partition=$target_partition_id map=$target_map"
            continue
          }
        fi
        target_row="$(partition_target_info "$target_partition_id")"
        IFS='|' read -r target_partition_id target_map target_dimension target_server_id <<< "$target_row"
      fi
    fi

    [ -n "$target_server_id" ] || continue

    if [ "$target_server_id" != "$old_server_id" ] || [ "$previous_partition_id" != "$target_partition_id" ] || [ "$target_dimension" != "$home_dimension_index" ]; then
      psql_value "
        update dune.encrypted_player_state
        set
          server_id = '$target_server_id',
          previous_server_partition_id = $target_partition_id,
          return_dimension_index = $target_dimension
        where account_id = $account_id;
      " >/dev/null
      echo "REMAP reconnect account=$account_id map=$target_map partition=$target_partition_id from=${old_server_id:-<empty>} to=$target_server_id"
      remember_server_id_map "$target_map" "$target_server_id"
    fi
  done
}

scan_travel_demand() {
  docker logs --since "$SINCE" dune-director 2>&1 \
    | python3 -c '
import re
import sys

pattern = re.compile(
    r"Processing travel queue for ClassicalInstancing group ([A-Za-z0-9_]+) "
    r"\(servers: \[[^\]]*\], num: ([0-9]+)\)"
)

seen = set()

for line in sys.stdin:
    match = pattern.search(line)
    if not match:
        continue

    map_name = match.group(1)
    num = int(match.group(2))

    if num <= 0:
        continue

    key = (map_name, num)
    if key in seen:
        continue

    seen.add(key)
    print(f"{map_name}|{num}")
' \
    | while IFS='|' read -r map num; do
        handle_demand "$map" "$num"
      done
}

while true; do
  scan_travel_demand
  scan_idle_servers
  scan_reconnect_demand
  sleep "$INTERVAL"
done
