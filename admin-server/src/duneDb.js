import { assertIdentifier, intParam, isReadOnlySql, quoteIdentifier, quoteQualified, rowsResult } from "./db.js";

export class UnsupportedCapabilityError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "UnsupportedCapabilityError";
    this.unsupported = true;
    this.details = details;
  }
}

export async function dbStatus(db) {
  const result = await db.query("select current_user, current_database(), version()");
  const tables = await db.query("select count(*)::int as count from information_schema.tables where table_schema = 'dune'");
  return { connected: true, config: db.config, server: result.rows[0], duneTableCount: tables.rows[0]?.count ?? 0, usesDefaultPassword: process.env.DUNE_DB_PASSWORD ? process.env.DUNE_DB_PASSWORD === "dune" : true };
}

export async function changeDunePassword(db, password) {
  const escaped = String(password).replaceAll("'", "''");
  await db.query(`alter role dune with password '${escaped}'`);
  return { ok: true, user: "dune" };
}

export async function listSchemas(db) {
  const result = await db.query("select schema_name from information_schema.schemata order by schema_name");
  return result.rows.map((row) => row.schema_name);
}

export async function listTables(db, schema = "dune") {
  assertIdentifier(schema, "schema");
  const result = await db.query(`
    select t.table_schema as schema,
           t.table_name as name,
           coalesce(s.n_live_tup, 0)::bigint as estimated_rows
    from information_schema.tables t
    left join pg_stat_user_tables s on s.schemaname = t.table_schema and s.relname = t.table_name
    where t.table_type = 'BASE TABLE' and t.table_schema = $1
    order by t.table_name`, [schema]);
  return result.rows;
}

export async function tableColumns(db, schema, table) {
  assertIdentifier(schema, "schema");
  assertIdentifier(table, "table");
  const result = await db.query(`
    select column_name as name, data_type, is_nullable, column_default
    from information_schema.columns
    where table_schema = $1 and table_name = $2
    order by ordinal_position`, [schema, table]);
  return result.rows;
}

export async function tableCount(db, schema, table) {
  const safe = quoteQualified(schema, table);
  const result = await db.query(`select count(*)::bigint as count from ${safe}`);
  return { schema, table, count: result.rows[0]?.count ?? "0" };
}

export async function tablePreview(db, schema, table, limit = 50, offset = 0) {
  const safe = quoteQualified(schema, table);
  const maxLimit = intParam(limit, "limit", 1, 500);
  const safeOffset = intParam(offset, "offset", 0);
  const result = await db.query(`select ctid::text as __rowid, * from ${safe} limit $1 offset $2`, [maxLimit, safeOffset]);
  return { schema, table, limit: maxLimit, offset: safeOffset, ...rowsResult(result) };
}

export async function updateTableRow(db, schema, table, rowId, values = {}) {
  assertIdentifier(schema, "schema");
  assertIdentifier(table, "table");
  const safe = quoteQualified(schema, table);
  const targetRow = String(rowId || "").trim();
  if (!/^\(\d+,\d+\)$/.test(targetRow)) throw new Error("Invalid row identifier");
  const columns = await tableColumns(db, schema, table);
  const editable = new Map(columns.map((column) => [column.name, column]));
  const entries = Object.entries(values || {}).filter(([key]) => key !== "__rowid" && editable.has(key));
  if (!entries.length) throw new Error("No editable column values were provided");
  if (entries.length > 100) throw new Error("Too many columns in one row update");

  const assignments = entries.map(([key], index) => `${quoteIdentifier(key)} = $${index + 1}`);
  const params = entries.map(([, value]) => normalizeEditableValue(value));
  params.push(targetRow);
  const result = await db.query(`update ${safe} set ${assignments.join(", ")} where ctid = $${params.length}::tid`, params);
  return { ok: true, updatedRows: result.rowCount || 0, schema, table };
}

function normalizeEditableValue(value) {
  if (value === undefined) return null;
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return value;
}

export async function searchDatabase(db, q) {
  const term = String(q || "").trim();
  if (!term) throw new Error("Search query is required");
  const result = await db.query(`
    select table_schema as schema, table_name as table, column_name as column, data_type
    from information_schema.columns
    where table_schema not in ('pg_catalog', 'information_schema')
      and (table_name ilike $1 or column_name ilike $1)
    order by table_schema, table_name, column_name
    limit 300`, [`%${term}%`]);
  return result.rows;
}

export async function runSql(db, query, allowDestructive = false) {
  const sql = String(query || "").trim();
  if (!sql) throw new Error("SQL query is required");
  if (!allowDestructive && !isReadOnlySql(sql)) throw new Error("Only read-only SQL is allowed without destructive confirmation");
  const result = await db.query(sql);
  return rowsResult(result);
}

export async function tableExists(db, name, schema = "dune") {
  const result = await db.query("select to_regclass($1) is not null as exists", [`${schema}.${name}`]);
  return Boolean(result.rows[0]?.exists);
}

export async function columnsFor(db, table, schema = "dune") {
  const result = await db.query(`
    select column_name
    from information_schema.columns
    where table_schema = $1 and table_name = $2`, [schema, table]);
  return new Set(result.rows.map((row) => row.column_name));
}

export async function listPlayers(db, { online = false, q = "" } = {}) {
  if (!(await tableExists(db, "actors")) || !(await tableExists(db, "player_state"))) {
    return unsupported("players", ["dune.actors", "dune.player_state"]);
  }
  const lastSeenSelect = await playerLastSeenSelect(db);
  const values = [];
  let where = "a.class ilike '%PlayerCharacter%'";
  where += " and coalesce(ac.\"user\", '') <> 'A5C0DE5E12A00001'";
  where += " and coalesce(ac.funcom_id, '') <> 'Server#0001'";
  where += " and coalesce(ps.character_name, '') <> 'Server'";
  if (online) where += " and coalesce(ps.online_status::text, '') = 'Online'";
  if (q) {
    values.push(`%${q}%`);
    where += ` and (ps.character_name ilike $${values.length} or ac."user" ilike $${values.length} or a.id::text = $${values.length} or a.owner_account_id::text = $${values.length})`;
  }
  const result = await db.query(`
    select a.id as actor_id,
           a.id as player_pawn_id,
           coalesce(a.owner_account_id, 0) as account_id,
           coalesce(ps.character_name, '') as character_name,
           coalesce(ps.player_controller_id, 0) as player_controller_id,
           coalesce(ac.funcom_id, '') as funcom_id,
           coalesce(ac."user", '') as fls_id,
           case
             when nullif(ac."user", '') is not null then ac."user"
             when a.owner_account_id is not null and a.owner_account_id <> 0 then a.owner_account_id::text
             else ''
           end as action_player_id,
           a.class,
           coalesce(a.map, '') as map,
           coalesce(ps.online_status::text, 'Offline') as online_status,
           ${lastSeenSelect} as last_seen
    from dune.actors a
    left join dune.player_state ps on ps.account_id = a.owner_account_id
    left join dune.accounts ac on ac.id = a.owner_account_id
    where ${where}
    order by lower(coalesce(ps.character_name, '')), a.id
    limit 500`, values);
  return { capabilities: { players: true, online }, rows: result.rows };
}

async function playerLastSeenSelect(db) {
  const candidates = [
    ["player_state", "ps", ["last_seen", "last_seen_at", "last_online", "last_online_at", "last_avatar_activity", "last_login", "last_login_at", "last_login_time", "last_activity", "last_activity_at", "updated_at"]],
    ["actors", "a", ["last_seen", "last_seen_at", "last_online", "last_online_at", "last_login", "last_login_at", "last_activity", "last_activity_at", "updated_at"]],
    ["accounts", "ac", ["last_seen", "last_seen_at", "last_online", "last_online_at", "last_login", "last_login_at", "last_activity", "last_activity_at", "updated_at"]]
  ];
  for (const [table, alias, names] of candidates) {
    if (!(await tableExists(db, table))) continue;
    const columns = await columnsFor(db, table);
    const found = names.find((name) => columns.has(name));
    if (found) return `${alias}.${quoteIdentifier(found)}::text`;
  }
  return "''";
}

export async function playerProfile(db, id) {
  const actorId = intParam(id, "player id", 1);
  const result = await db.query(`
    select a.id as actor_id,
           a.id as player_pawn_id,
           coalesce(a.owner_account_id, 0) as account_id,
           coalesce(ps.character_name, '') as character_name,
           coalesce(ps.player_controller_id, 0) as player_controller_id,
           coalesce(ac.funcom_id, '') as funcom_id,
           coalesce(ac."user", '') as fls_id,
           case
             when nullif(ac."user", '') is not null then ac."user"
             when a.owner_account_id is not null and a.owner_account_id <> 0 then a.owner_account_id::text
             else ''
           end as action_player_id,
           a.class,
           coalesce(a.map, '') as map,
           coalesce(ps.online_status::text, 'Offline') as online_status
    from dune.actors a
    left join dune.player_state ps on ps.account_id = a.owner_account_id
    left join dune.accounts ac on ac.id = a.owner_account_id
    where a.id = $1`, [actorId]);
  if (!result.rows[0]) throw new Error("Player not found");
  return { capabilities: await playerCapabilities(db), player: result.rows[0] };
}

export async function playerInventory(db, id) {
  if (!(await tableExists(db, "items")) || !(await tableExists(db, "inventories"))) return unsupported("inventory", ["dune.items", "dune.inventories"]);
  const result = await db.query(`
    select i.id,
           i.template_id,
           i.stack_size,
           i.quality_level,
           i.position_index,
           i.inventory_id,
           coalesce((i.stats->'FItemStackAndDurabilityStats'->1->>'CurrentDurability'), null) as current_durability,
           coalesce((i.stats->'FItemStackAndDurabilityStats'->1->>'MaxDurability'), null) as max_durability,
           i.stats
    from dune.items i
    join dune.inventories inv on i.inventory_id = inv.id
    where inv.actor_id = $1
    order by i.template_id`, [intParam(id, "player id", 1)]);
  return { capabilities: { inventory: true }, rows: result.rows };
}

export async function playerCurrency(db, id) {
  if (!(await tableExists(db, "player_virtual_currency_balances"))) return unsupported("currency", ["dune.player_virtual_currency_balances"]);
  const actorId = intParam(id, "player id", 1);
  const result = await db.query(`
    select currency_id, balance
    from dune.player_virtual_currency_balances
    where player_controller_id = $1
       or player_controller_id = (select coalesce(player_controller_id, 0) from dune.player_state where player_pawn_id = $1 limit 1)
    order by currency_id`, [actorId]);
  return { capabilities: { currency: true }, rows: result.rows };
}

export async function playerFactions(db, id) {
  if (!(await tableExists(db, "player_faction_reputation"))) return unsupported("factions", ["dune.player_faction_reputation"]);
  const hasFactions = await tableExists(db, "factions");
  const result = await db.query(`
    select pfr.actor_id,
           pfr.faction_id,
           ${hasFactions ? "coalesce(f.name, '')" : "''"} as faction_name,
           pfr.reputation_amount
    from dune.player_faction_reputation pfr
    ${hasFactions ? "left join dune.factions f on f.id = pfr.faction_id" : ""}
    where pfr.actor_id = $1
    order by pfr.faction_id`, [intParam(id, "player id", 1)]);
  return { capabilities: { factions: true, factionNames: hasFactions }, rows: result.rows };
}

export async function playerSpecs(db, id) {
  if (!(await tableExists(db, "specialization_tracks"))) return unsupported("specs", ["dune.specialization_tracks"]);
  const result = await db.query(`
    select player_id, track_type::text, xp_amount, level
    from dune.specialization_tracks
    where player_id = $1
    order by track_type`, [intParam(id, "player id", 1)]);
  return { capabilities: { specs: true }, rows: result.rows };
}

export async function playerPosition(db, id) {
  const actorId = intParam(id, "player id", 1);
  try {
    const result = await db.query(`
      select id as actor_id, map, (transform).location::text as location, (transform).rotation::text as rotation
      from dune.actors
      where id = $1`, [actorId]);
    return { capabilities: { position: true }, position: result.rows[0] || null };
  } catch (error) {
    return { capabilities: { position: false }, reason: "dune.actors transform composite columns were not available", error: error.message };
  }
}

export async function liveMapCapabilities(db) {
  const actors = await tableExists(db, "actors");
  const playerState = await tableExists(db, "player_state");
  const vehicles = await tableExists(db, "vehicles");
  const placeables = await tableExists(db, "placeables");
  const buildings = await tableExists(db, "buildings");
  const worldPartition = await tableExists(db, "world_partition");
  const farmState = await tableExists(db, "farm_state");
  return {
    players: actors && playerState,
    vehicles: actors && vehicles,
    storage: actors && placeables,
    bases: actors && buildings,
    services: worldPartition,
    farmState,
    coordinateTransform: "Uses raw dune.actors.transform world coordinates; calibrated image/world transform is not verified."
  };
}

const LIVE_MAP_CONFIGS = {
  HaggaBasin: {
    key: "HaggaBasin",
    label: "Hagga Basin",
    actorMap: "HaggaBasin",
    image: "/images/maps/hagga-basin.png",
    width: 4096,
    height: 4096,
    minX: -456752.21,
    maxX: 354547.46,
    minY: -450630.14,
    maxY: 353821.95,
    flipY: false,
    defaultPartitionId: 1
  },
  DeepDesert: {
    key: "DeepDesert",
    label: "The Deep Desert",
    actorMap: "DeepDesert",
    image: "/images/maps/deep-desert.png",
    width: 4096,
    height: 4096,
    minX: -1268624.82,
    maxX: 1163312.83,
    minY: -1266548.17,
    maxY: 1162416.13,
    flipY: false,
    defaultPartitionId: 8
  }
};

export function liveMapConfigPayload(selected = "") {
  const key = LIVE_MAP_CONFIGS[selected] ? selected : "HaggaBasin";
  return {
    map: LIVE_MAP_CONFIGS[key],
    maps: LIVE_MAP_CONFIGS,
    defaultMap: "HaggaBasin"
  };
}

export async function liveMapPartitions(db) {
  if (!(await tableExists(db, "actors"))) return { rows: [] };
  const hasWorldPartition = await tableExists(db, "world_partition");
  const result = await db.query(`
    select coalesce(a.map, '') as map,
           coalesce(a.partition_id, 0) as partition_id,
           ${hasWorldPartition ? "coalesce(nullif(wp.label, ''), nullif(wp.map, ''), 'Partition ' || coalesce(a.partition_id, 0)::text)" : "'Partition ' || coalesce(a.partition_id, 0)::text"} as name,
           count(*)::int as marker_count
    from dune.actors a
    ${hasWorldPartition ? "left join dune.world_partition wp on wp.partition_id = a.partition_id" : ""}
    where a.transform is not null
    group by a.map, a.partition_id${hasWorldPartition ? ", wp.label, wp.map" : ""}
    order by map, partition_id`);
  return { rows: result.rows.map((row) => ({ ...row, partition_id: Number(row.partition_id || 0), marker_count: Number(row.marker_count || 0) })) };
}

export async function liveMapPlayers(db, map = "") {
  if (!(await tableExists(db, "actors")) || !(await tableExists(db, "player_state"))) return unsupportedMap("players", ["dune.actors", "dune.player_state"]);
  const values = [];
  const where = mapFilterClause(map, values, "a");
  try {
    const result = await db.query(`
      select a.id,
             'player' as type,
             coalesce(nullif(ps.character_name, ''), 'Unknown') as name,
             coalesce(ps.online_status::text, '') as online_status,
             coalesce(a.map, '') as map,
             coalesce(a.partition_id, 0) as partition_id,
             coalesce(a.class, '') as class,
             ((a.transform).location).x as x,
             ((a.transform).location).y as y,
             ((a.transform).location).z as z
      from dune.actors a
      join dune.player_state ps on ps.player_pawn_id = a.id
      where a.transform is not null ${where}
      order by coalesce(ps.online_status::text, '') desc, lower(coalesce(ps.character_name, ''))`, values);
    return { capabilities: { players: true }, rows: result.rows.map(normalizeMarker) };
  } catch (error) {
    return { capabilities: { players: false }, rows: [], reason: `Player marker transform query is unsupported by this schema: ${error.message}` };
  }
}

export async function liveMapVehicles(db, map = "") {
  if (!(await tableExists(db, "actors")) || !(await tableExists(db, "vehicles"))) return unsupportedMap("vehicles", ["dune.actors", "dune.vehicles"]);
  const values = [];
  const where = mapFilterClause(map, values, "a");
  try {
    const result = await db.query(`
      select a.id,
             'vehicle' as type,
             coalesce(a.class, '') as name,
             coalesce(a.map, '') as map,
             coalesce(a.partition_id, 0) as partition_id,
             coalesce(a.class, '') as class,
             ((a.transform).location).x as x,
             ((a.transform).location).y as y,
             ((a.transform).location).z as z
      from dune.vehicles v
      join dune.actors a on a.id = v.id
      where a.transform is not null ${where}
      order by a.map, a.partition_id, a.id`, values);
    return { capabilities: { vehicles: true }, rows: result.rows.map(normalizeMarker) };
  } catch (error) {
    return { capabilities: { vehicles: false }, rows: [], reason: `Vehicle marker transform query is unsupported by this schema: ${error.message}` };
  }
}

export async function liveMapStorage(db, map = "") {
  if (!(await tableExists(db, "actors")) || !(await tableExists(db, "placeables"))) return unsupportedMap("storage", ["dune.actors", "dune.placeables"]);
  const values = [];
  const where = mapFilterClause(map, values, "a");
  try {
    const result = await db.query(`
      select p.id,
             'storage' as type,
             coalesce(max(case when pa.actor_name not like '##%' and pa.actor_name <> 'None' then pa.actor_name end), p.building_type) as name,
             coalesce(a.map, '') as map,
             coalesce(a.partition_id, 0) as partition_id,
             p.building_type as class,
             count(i.id)::int as item_count,
             ((a.transform).location).x as x,
             ((a.transform).location).y as y,
             ((a.transform).location).z as z
      from dune.placeables p
      join dune.actors a on a.id = p.id
      left join dune.permission_actor pa on pa.actor_id = p.id
      left join dune.inventories inv on inv.actor_id = p.id
      left join dune.items i on i.inventory_id = inv.id
      where p.building_type in ('SpiceSilo_Placeable','GenericContainer_Placeable','StorageContainer_Placeable','MediumStorageContainer_Placeable')
        and a.transform is not null ${where}
      group by p.id, p.building_type, a.map, a.partition_id, a.transform
      order by a.map, a.partition_id, p.id`, values);
    return { capabilities: { storage: true }, rows: result.rows.map(normalizeMarker) };
  } catch (error) {
    return { capabilities: { storage: false }, rows: [], reason: `Storage marker transform query is unsupported by this schema: ${error.message}` };
  }
}

export async function liveMapBases(db, map = "") {
  if (!(await tableExists(db, "actors")) || !(await tableExists(db, "buildings"))) return unsupportedMap("bases", ["dune.actors", "dune.buildings"]);
  const values = [];
  const where = mapFilterClause(map, values, "a");
  try {
    const result = await db.query(`
      select b.id,
             'base' as type,
             coalesce(pa.actor_name, 'Base ' || b.id::text) as name,
             coalesce(a.map, '') as map,
             coalesce(a.partition_id, 0) as partition_id,
             coalesce(a.class, '') as class,
             ((a.transform).location).x as x,
             ((a.transform).location).y as y,
             ((a.transform).location).z as z
      from dune.buildings b
      join dune.building_instances bi on bi.building_id = b.id
      join dune.actor_fgl_entities afe on afe.entity_id = bi.owner_entity_id
      join dune.actors a on a.id = afe.actor_id
      left join dune.permission_actor pa on pa.actor_id = a.id
      where a.transform is not null ${where}
      group by b.id, pa.actor_name, a.id, a.map, a.partition_id, a.class, a.transform
      order by a.map, a.partition_id, b.id`, values);
    return { capabilities: { bases: true }, rows: result.rows.map(normalizeMarker) };
  } catch (error) {
    return { capabilities: { bases: false }, rows: [], reason: `Base marker transform query is unsupported by this schema: ${error.message}` };
  }
}

export async function liveMapServices(db, map = "") {
  if (!(await tableExists(db, "world_partition"))) return unsupportedMap("services", ["dune.world_partition"]);
  const hasFarm = await tableExists(db, "farm_state");
  const values = [];
  const where = mapFilterClause(map, values, "wp");
  const result = await db.query(`
    select wp.partition_id,
           'service' as type,
           coalesce(wp.label, wp.map || ' #' || wp.partition_id::text) as name,
           coalesce(wp.map, '') as map,
           coalesce(wp.dimension_index, 0) as dimension_index,
           coalesce(wp.server_id, '') as server_id,
           coalesce(wp.blocked, false) as blocked,
           ${hasFarm ? "coalesce(fs.alive, false)" : "false"} as alive,
           ${hasFarm ? "coalesce(fs.ready, false)" : "false"} as ready,
           ${hasFarm ? "coalesce(fs.connected_players, 0)" : "0"} as connected_players
    from dune.world_partition wp
    ${hasFarm ? "left join dune.farm_state fs on fs.server_id = wp.server_id" : ""}
    where 1=1 ${where}
    order by wp.map, wp.dimension_index, wp.partition_id`, values);
  return { capabilities: { services: true, farmState: hasFarm }, rows: result.rows };
}

export async function liveMapMarkers(db, map = "") {
  const [players, vehicles, bases, storage] = await Promise.all([
    liveMapPlayers(db, map),
    liveMapVehicles(db, map),
    liveMapBases(db, map),
    liveMapStorage(db, map)
  ]);
  return {
    capabilities: await liveMapCapabilities(db),
    overlays: {
      players: players.reason || "",
      vehicles: vehicles.reason || "",
      bases: bases.reason || "",
      storage: storage.reason || ""
    },
    rows: [
      ...(players.rows || []),
      ...(vehicles.rows || []),
      ...(bases.rows || []),
      ...(storage.rows || [])
    ]
  };
}

export async function unsupportedPlayerFeature(db, id, feature) {
  intParam(id, "player id", 1);
  return { capabilities: { [feature]: false }, rows: [], reason: `${feature} schema has not been detected in this database yet` };
}

export async function listStorage(db) {
  if (!(await tableExists(db, "placeables"))) return unsupported("storage", ["dune.placeables"]);
  const result = await db.query(`
    select p.id,
           coalesce(max(case when pa.actor_name not like '##%' and pa.actor_name <> 'None' then pa.actor_name end), '') as name,
           p.building_type as class,
           coalesce(a.map, '') as map,
           count(i.id)::int as item_count,
           coalesce(max(ps.character_name), '') as owner_name
    from dune.placeables p
    left join dune.actors a on a.id = p.id
    left join dune.permission_actor pa on pa.actor_id = p.id
    left join dune.inventories inv on inv.actor_id = p.id
    left join dune.items i on i.inventory_id = inv.id
    left join dune.actor_fgl_entities afe on afe.entity_id = p.owner_entity_id
    left join dune.permission_actor_rank par on par.permission_actor_id = afe.actor_id
    left join dune.actors player_a on player_a.id = par.player_id
    left join dune.player_state ps on ps.account_id = player_a.owner_account_id
    where p.building_type in ('SpiceSilo_Placeable','GenericContainer_Placeable','StorageContainer_Placeable','MediumStorageContainer_Placeable')
      and p.is_hologram = false and p.owner_entity_id is not null and p.owner_entity_id != 0
    group by p.id, p.building_type, a.map
    order by p.id`);
  return { capabilities: { storage: true, storageGiveItem: await supportsStorageGiveItem(db) }, rows: result.rows };
}

export async function storageItems(db, id) {
  return playerInventory(db, id);
}

export async function storageCapabilities(db) {
  return {
    storageGiveItem: await supportsStorageGiveItem(db)
  };
}

export async function exportRows(db, query) {
  const result = await runSql(db, query, false);
  return JSON.stringify(result, null, 2);
}

export async function addCurrency(db, id, { currencyId = 0, amount }) {
  await requireCapability(await supportsCurrencyMutation(db), "Currency mutation requires dune.player_virtual_currency_balances plus dune.adjust_player_virtual_currency_balance(bigint,smallint,bigint).");
  const delta = intParam(amount, "currency amount", -1000000000000, 1000000000000);
  if (delta === 0) throw new Error("Currency amount cannot be zero");
  const resolvedCurrencyId = await resolveCurrencyId(db, currencyId);
  return db.transaction(async (tx) => {
    const player = await resolvePlayerMutationTarget(tx, id);
    await tx.query("select dune.adjust_player_virtual_currency_balance($1::bigint, $2::smallint, $3::bigint)", [player.controllerId, resolvedCurrencyId, delta]);
    const balance = await tx.query(`
      select currency_id, balance
      from dune.player_virtual_currency_balances
      where player_controller_id = $1 and currency_id = $2`, [player.controllerId, resolvedCurrencyId]);
    return { ok: true, player, currencyId: resolvedCurrencyId, amount: delta, balance: balance.rows[0] || null };
  });
}

export async function addFactionReputation(db, id, { factionId, amount }) {
  await requireCapability(await supportsFactionMutation(db), "Faction reputation mutation requires dune.player_faction_reputation, dune.actors.properties, and dune.set_player_faction_reputation(bigint,smallint,integer).");
  const faction = intParam(factionId, "faction id", 1, 32767);
  const delta = intParam(amount, "faction reputation amount", -12474, 12474);
  if (delta === 0) throw new Error("Faction reputation amount cannot be zero");
  return db.transaction(async (tx) => {
    const player = await resolvePlayerMutationTarget(tx, id);
    const current = await tx.query(`
      select reputation_amount
      from dune.player_faction_reputation
      where actor_id = $1 and faction_id = $2`, [player.actorId, faction]);
    const oldValue = Number(current.rows[0]?.reputation_amount || 0);
    const nextValue = Math.max(0, Math.min(12474, oldValue + delta));
    await tx.query("select dune.set_player_faction_reputation($1::bigint, $2::smallint, $3::integer)", [player.actorId, faction, nextValue]);
    if (faction === 1 || faction === 2) await syncFactionComponent(tx, player.actorId);
    return { ok: true, player, factionId: faction, oldValue, newValue: nextValue };
  });
}

export async function addIntel(db, id, { amount }) {
  await requireCapability(await supportsIntelMutation(db), "Intel mutation requires dune.actors.properties with TechKnowledgePlayerComponent.");
  const delta = intParam(amount, "intel amount", -1000000000, 1000000000);
  if (delta === 0) throw new Error("Intel amount cannot be zero");
  return db.transaction(async (tx) => {
    const player = await resolvePlayerMutationTarget(tx, id);
    const current = await tx.query(`
      select (properties->'TechKnowledgePlayerComponent'->>'m_TechKnowledgePoints')::bigint as intel
      from dune.actors
      where id = $1 and properties ? 'TechKnowledgePlayerComponent'`, [player.actorId]);
    if (!current.rows.length) throw new UnsupportedCapabilityError(`TechKnowledgePlayerComponent not found for player ${player.actorId}.`);
    const oldValue = Number(current.rows[0]?.intel || 0);
    const nextValue = Math.max(0, oldValue + delta);
    await tx.query(`
      update dune.actors
      set properties = jsonb_set(properties, '{TechKnowledgePlayerComponent,m_TechKnowledgePoints}', to_jsonb($2::bigint))
      where id = $1 and properties ? 'TechKnowledgePlayerComponent'`, [player.actorId, nextValue]);
    return { ok: true, player, oldValue, newValue: nextValue, amount: delta };
  });
}

export async function playerCraftingRecipes(db, id) {
  await requireCapability(await supportsCraftingRecipes(db), "Crafting recipes require dune.actors.properties with CraftingRecipesLibraryActorComponent.");
  const player = await resolvePlayerMutationTarget(db, id);
  const result = await db.query(`
    with all_recipes as (
      select distinct on (recipe->'BaseRecipeId'->>'Name')
             recipe->'BaseRecipeId'->>'Name' as recipe_id,
             coalesce(nullif(recipe->>'m_Source', ''), 'Unknown') as source,
             case when recipe->>'m_QualityLevel' ~ '^-?[0-9]+$' then (recipe->>'m_QualityLevel')::int else 0 end as quality_level
      from dune.actors a
      cross join lateral jsonb_array_elements(coalesce(a.properties->'CraftingRecipesLibraryActorComponent'->'m_KnownItemRecipes', '[]'::jsonb)) recipe
      where recipe->'BaseRecipeId'->>'Name' is not null
      order by recipe->'BaseRecipeId'->>'Name', coalesce(nullif(recipe->>'m_Source', ''), 'Unknown')
    ),
    player_recipes as (
      select recipe->'BaseRecipeId'->>'Name' as recipe_id
      from dune.actors a
      cross join lateral jsonb_array_elements(coalesce(a.properties->'CraftingRecipesLibraryActorComponent'->'m_KnownItemRecipes', '[]'::jsonb)) recipe
      where a.id = $1 and recipe->'BaseRecipeId'->>'Name' is not null
    )
    select all_recipes.recipe_id,
           all_recipes.source,
           all_recipes.quality_level,
           (player_recipes.recipe_id is not null) as unlocked
    from all_recipes
    left join player_recipes on player_recipes.recipe_id = all_recipes.recipe_id
    order by all_recipes.recipe_id`, [player.actorId]);
  return {
    capabilities: { craftingRecipes: true },
    player,
    rows: result.rows.map((row) => ({
      recipeId: row.recipe_id,
      displayName: recipeDisplayName(row.recipe_id),
      category: recipeCategory(row.recipe_id),
      source: row.source || "Unknown",
      qualityLevel: Number(row.quality_level || 0),
      unlocked: Boolean(row.unlocked)
    }))
  };
}

export async function unlockCraftingRecipe(db, id, { recipeId }) {
  await requireCapability(await supportsCraftingRecipes(db), "Crafting recipes require dune.actors.properties with CraftingRecipesLibraryActorComponent.");
  const safeRecipeId = validateRecipeId(recipeId);
  return db.transaction(async (tx) => {
    const player = await resolvePlayerMutationTarget(tx, id);
    const known = await tx.query(`
      select exists (
        select 1
        from dune.actors a
        cross join lateral jsonb_array_elements(coalesce(a.properties->'CraftingRecipesLibraryActorComponent'->'m_KnownItemRecipes', '[]'::jsonb)) recipe
        where recipe->'BaseRecipeId'->>'Name' = $1
      ) as exists`, [safeRecipeId]);
    if (!known.rows[0]?.exists) throw new Error(`Crafting recipe ${safeRecipeId} was not found in the game database.`);
    const current = await tx.query(`
      select properties->'CraftingRecipesLibraryActorComponent'->'m_KnownItemRecipes' as recipes
      from dune.actors
      where id = $1 and properties ? 'CraftingRecipesLibraryActorComponent'
      for update`, [player.actorId]);
    if (!current.rows.length) throw new UnsupportedCapabilityError(`CraftingRecipesLibraryActorComponent not found for player ${player.actorId}.`);
    const recipes = Array.isArray(current.rows[0]?.recipes) ? current.rows[0].recipes : [];
    if (recipes.some((recipe) => recipe?.BaseRecipeId?.Name === safeRecipeId)) {
      return { ok: true, player, recipeId: safeRecipeId, alreadyUnlocked: true };
    }
    const nextRecipes = [...recipes, {
      m_Source: "SchematicPickup",
      m_bIsNew: true,
      BaseRecipeId: { Name: safeRecipeId },
      m_QualityLevel: 0,
      m_NumberOfRecipeUses: 0,
      m_bIsLimitedUseRecipe: false
    }];
    await tx.query(`
      update dune.actors
      set properties = jsonb_set(properties, '{CraftingRecipesLibraryActorComponent,m_KnownItemRecipes}', $2::jsonb, true)
      where id = $1 and properties ? 'CraftingRecipesLibraryActorComponent'`, [player.actorId, JSON.stringify(nextRecipes)]);
    return { ok: true, player, recipeId: safeRecipeId, alreadyUnlocked: false };
  });
}

export async function playerResearchItems(db, id) {
  await requireCapability(await supportsResearchItems(db), "Research unlocks require dune.actors.properties with TechKnowledgePlayerComponent.");
  const player = await resolvePlayerMutationTarget(db, id);
  const result = await db.query(`
    with all_research as (
      select distinct item->>'ItemKey' as item_key
      from dune.actors a
      cross join lateral jsonb_array_elements(coalesce(a.properties->'TechKnowledgePlayerComponent'->'m_TechKnowledge'->'m_TechKnowledgeData', '[]'::jsonb)) item
      where item->>'ItemKey' is not null
    ),
    player_research as (
      select item->>'ItemKey' as item_key,
             coalesce(nullif(item->>'UnlockedState', ''), 'Unknown') as unlocked_state,
             coalesce((item->>'bIsNewEntry')::boolean, false) as is_new
      from dune.actors a
      cross join lateral jsonb_array_elements(coalesce(a.properties->'TechKnowledgePlayerComponent'->'m_TechKnowledge'->'m_TechKnowledgeData', '[]'::jsonb)) item
      where a.id = $1 and item->>'ItemKey' is not null
    )
    select all_research.item_key,
           coalesce(player_research.unlocked_state, 'Missing') as unlocked_state,
           coalesce(player_research.is_new, false) as is_new
    from all_research
    left join player_research on player_research.item_key = all_research.item_key
    order by all_research.item_key`, [player.actorId]);
  return {
    capabilities: { researchItems: true },
    player,
    rows: result.rows.map((row) => ({
      itemKey: row.item_key,
      displayName: researchDisplayName(row.item_key),
      category: researchCategory(row.item_key),
      productGroup: researchProductGroup(row.item_key, researchCategory(row.item_key)),
      type: researchType(row.item_key),
      unlockedState: row.unlocked_state || "Unknown",
      isNew: Boolean(row.is_new),
      unlocked: row.unlocked_state === "Purchased"
    }))
  };
}

export async function unlockResearchItem(db, id, { itemKey }) {
  await requireCapability(await supportsResearchItems(db), "Research unlocks require dune.actors.properties with TechKnowledgePlayerComponent.");
  const safeItemKey = validateResearchKey(itemKey);
  return db.transaction(async (tx) => {
    const player = await resolvePlayerMutationTarget(tx, id);
    const known = await tx.query(`
      select exists (
        select 1
        from dune.actors a
        cross join lateral jsonb_array_elements(coalesce(a.properties->'TechKnowledgePlayerComponent'->'m_TechKnowledge'->'m_TechKnowledgeData', '[]'::jsonb)) item
        where item->>'ItemKey' = $1
      ) as exists`, [safeItemKey]);
    if (!known.rows[0]?.exists) throw new Error(`Research key ${safeItemKey} was not found in the game database.`);
    const current = await tx.query(`
      select properties->'TechKnowledgePlayerComponent'->'m_TechKnowledge'->'m_TechKnowledgeData' as items
      from dune.actors
      where id = $1 and properties ? 'TechKnowledgePlayerComponent'
      for update`, [player.actorId]);
    if (!current.rows.length) throw new UnsupportedCapabilityError(`TechKnowledgePlayerComponent not found for player ${player.actorId}.`);
    const items = Array.isArray(current.rows[0]?.items) ? current.rows[0].items : [];
    let alreadyUnlocked = false;
    let found = false;
    const nextItems = items.map((item) => {
      if (item?.ItemKey !== safeItemKey) return item;
      found = true;
      alreadyUnlocked = item.UnlockedState === "Purchased";
      return { ...item, bIsNewEntry: false, UnlockedState: "Purchased" };
    });
    if (!found) {
      nextItems.push({ ItemKey: safeItemKey, bIsNewEntry: false, UnlockedState: "Purchased" });
    }
    await tx.query(`
      update dune.actors
      set properties = jsonb_set(properties, '{TechKnowledgePlayerComponent,m_TechKnowledge,m_TechKnowledgeData}', $2::jsonb, true)
      where id = $1 and properties ? 'TechKnowledgePlayerComponent'`, [player.actorId, JSON.stringify(nextItems)]);
    const recipeId = researchRecipeId(safeItemKey);
    const recipeMaterialized = recipeId ? await materializeCraftingRecipeIfKnown(tx, player.actorId, recipeId) : false;
    return { ok: true, player, itemKey: safeItemKey, alreadyUnlocked, recipeId, recipeMaterialized };
  });
}

export async function playerJourney(db, id, journeyTagsData = {}) {
  await requireCapability(await supportsJourney(db), "Journey data requires dune.journey_story_node, dune.player_tags, dune.tutorials, and dune.tutorial_per_player.");
  const player = await resolvePlayerMutationTarget(db, id);
  const tagMap = journeyTagsData?.journey_node_tags || {};
  const contractTags = journeyTagsData?.contract_tags || {};
  const contractAliases = journeyTagsData?.contract_aliases || {};
  const taggedNodeIds = Object.keys(tagMap).sort((a, b) => a.localeCompare(b));
  const knownNodeIds = taggedNodeIds.length ? taggedNodeIds : [];
  const contractNodeIds = Object.values(contractAliases).filter(Boolean).sort((a, b) => String(a).localeCompare(String(b)));
  const codex = await db.query(`
    select story_node_id
    from dune.journey_story_node
    where story_node_id like 'DA_Dunipedia_%'
    group by story_node_id
    order by story_node_id`);
  const playerNodes = await db.query(`
    select story_node_id,
           complete_condition_state = 'true'::jsonb as is_complete,
           reveal_condition_state = 'true'::jsonb as is_revealed,
           coalesce(has_pending_reward, false) as has_pending_reward
    from dune.journey_story_node
    where account_id = $1`, [player.accountId]);
  const playerTags = await db.query("select tag from dune.player_tags where account_id = $1", [player.accountId]);
  const state = new Map(playerNodes.rows.map((row) => [row.story_node_id, {
    complete: Boolean(row.is_complete),
    revealed: Boolean(row.is_revealed),
    pendingReward: Boolean(row.has_pending_reward)
  }]));
  const tagState = new Set(playerTags.rows.map((row) => String(row.tag || "")));
  const tutorialRows = await db.query(`
    select t.id,
           t.name,
           tp.tutorial_state
    from dune.tutorials t
    left join dune.tutorial_per_player tp on tp.tutorial_id = t.id and tp.player_id = $1
    order by t.name`, [player.controllerId]);

  const storyRows = knownNodeIds.filter((nodeId) => journeyGroup(nodeId) === "story").map((nodeId) => journeyNodeRow(nodeId, "Story", state, tagMap, knownNodeIds));
  const journeyContractRows = knownNodeIds.filter((nodeId) => journeyGroup(nodeId) === "contract").map((nodeId) => journeyNodeRow(nodeId, "Contract", state, tagMap, knownNodeIds));
  const contractRows = [
    ...journeyContractRows,
    ...contractNodeIds.map((nodeId) => contractNodeRow(String(nodeId), contractTags, contractAliases, tagState))
  ].sort((a, b) => a.rawName.localeCompare(b.rawName));
  const codexIds = codex.rows.map((row) => row.story_node_id).filter(Boolean);
  const codexRows = codexIds.map((nodeId) => journeyNodeRow(nodeId, "Codex", state, {}, codexIds));
  const tutorial = tutorialRows.rows.map((row) => ({
    id: String(row.id),
    name: journeyDisplayName(row.name),
    rawName: String(row.name || ""),
    category: "Tutorial",
    depth: 0,
    parentId: "",
    status: tutorialStatus(row.tutorial_state),
    complete: Number(row.tutorial_state) === 2,
    state: row.tutorial_state === null || row.tutorial_state === undefined ? null : Number(row.tutorial_state),
    tags: 0
  }));
  return { capabilities: { journey: true }, player, rows: { story: storyRows, contract: contractRows, codex: codexRows, tutorial } };
}

export async function completeJourneyNode(db, id, { nodeId }, journeyTagsData = {}) {
  await requireCapability(await supportsJourney(db), "Journey completion requires dune.journey_story_node and dune.update_player_tags(bigint,text[],text[]).");
  const safeNodeId = validateJourneyNodeId(nodeId);
  return db.transaction(async (tx) => {
    const player = await resolvePlayerMutationTarget(tx, id);
    if (isContractNode(safeNodeId, journeyTagsData)) {
      const tags = contractTagsForNode(safeNodeId, journeyTagsData);
      const tagResult = await applyJourneyTags(tx, player, tags, "add");
      return { ok: true, player, nodeId: safeNodeId, updatedRows: 0, tagsApplied: tags.length, factionBumps: tagResult.factionBumps, contract: true };
    }
    const updated = await tx.query(`
      update dune.journey_story_node
      set complete_condition_state = 'true'::jsonb,
          reveal_condition_state = 'true'::jsonb
      where account_id = $1
        and (story_node_id = $2 or story_node_id like $2 || '.%')`, [player.accountId, safeNodeId]);
    let updatedRows = Number(updated.rowCount || 0);
    if (updatedRows === 0) {
      await tx.query(`
        insert into dune.journey_story_node
          (account_id, story_node_id, has_pending_reward, complete_condition_state, reveal_condition_state, fail_condition_state, metadata_state, reset_group)
        values ($1, $2, false, 'true'::jsonb, 'true'::jsonb, '{}'::jsonb, '{}'::jsonb, 'Default'::dune.JourneyStoryResetGroup)`, [player.accountId, safeNodeId]);
      updatedRows = 1;
    }
    const tags = tagsForJourneyNodeSubtree(safeNodeId, journeyTagsData);
    const tagResult = await applyJourneyTags(tx, player, tags, "add");
    return { ok: true, player, nodeId: safeNodeId, updatedRows, tagsApplied: tags.length, factionBumps: tagResult.factionBumps };
  });
}

export async function resetJourneyNode(db, id, { nodeId }, journeyTagsData = {}) {
  await requireCapability(await supportsJourney(db), "Journey reset requires dune.journey_story_node and dune.update_player_tags(bigint,text[],text[]).");
  const safeNodeId = validateJourneyNodeId(nodeId);
  return db.transaction(async (tx) => {
    const player = await resolvePlayerMutationTarget(tx, id);
    if (isContractNode(safeNodeId, journeyTagsData)) {
      const tags = contractTagsForNode(safeNodeId, journeyTagsData);
      await applyJourneyTags(tx, player, tags, "remove");
      return { ok: true, player, nodeId: safeNodeId, updatedRows: 0, tagsRemoved: tags.length, contract: true };
    }
    const updated = await tx.query(`
      update dune.journey_story_node
      set complete_condition_state = 'false'::jsonb,
          has_pending_reward = false
      where account_id = $1
        and (story_node_id = $2 or story_node_id like $2 || '.%')`, [player.accountId, safeNodeId]);
    const tags = tagsForJourneyNodeSubtree(safeNodeId, journeyTagsData);
    await applyJourneyTags(tx, player, tags, "remove");
    return { ok: true, player, nodeId: safeNodeId, updatedRows: Number(updated.rowCount || 0), tagsRemoved: tags.length };
  });
}

export async function completeTutorial(db, id, { tutorialId }) {
  await requireCapability(await supportsTutorials(db), "Tutorial completion requires dune.tutorials and dune.tutorial_per_player.");
  const safeTutorialId = intParam(tutorialId, "tutorial id", 1, 32767);
  return db.transaction(async (tx) => {
    const player = await resolvePlayerMutationTarget(tx, id);
    const known = await tx.query("select exists (select 1 from dune.tutorials where id = $1) as exists", [safeTutorialId]);
    if (!known.rows[0]?.exists) throw new Error(`Tutorial ${safeTutorialId} was not found in the game database.`);
    await tx.query("select dune.create_or_update_tutorial_entry($1::bigint, $2::smallint, 2::smallint)", [player.controllerId, safeTutorialId]);
    return { ok: true, player, tutorialId: safeTutorialId, state: 2 };
  });
}

export async function resetTutorial(db, id, { tutorialId }) {
  await requireCapability(await supportsTutorials(db), "Tutorial reset requires dune.tutorials and dune.tutorial_per_player.");
  const safeTutorialId = intParam(tutorialId, "tutorial id", 1, 32767);
  return db.transaction(async (tx) => {
    const player = await resolvePlayerMutationTarget(tx, id);
    const deleted = await tx.query("delete from dune.tutorial_per_player where player_id = $1 and tutorial_id = $2", [player.controllerId, safeTutorialId]);
    return { ok: true, player, tutorialId: safeTutorialId, deletedRows: Number(deleted.rowCount || 0) };
  });
}

export async function deleteInventoryItem(db, playerId, itemId) {
  await requireCapability(await supportsInventoryDelete(db), "Inventory delete requires dune.items, dune.inventories, and dune.delete_item(bigint).");
  const safeItemId = intParam(itemId, "item id", 1);
  return db.transaction(async (tx) => {
    const player = await resolvePlayerMutationTarget(tx, playerId);
    const item = await tx.query(`
      select i.id, i.template_id, i.stack_size, i.quality_level, i.position_index, i.inventory_id, inv.actor_id
      from dune.items i
      join dune.inventories inv on inv.id = i.inventory_id
      where i.id = $1 and inv.actor_id = $2
      for update`, [safeItemId, player.actorId]);
    if (!item.rows[0]) throw new Error("Inventory item was not found in the selected player's directly-owned inventory");
    await tx.query("select dune.delete_item($1::bigint)", [safeItemId]);
    return { ok: true, player, deleted: item.rows[0] };
  });
}

export async function giveItemToStorage(db, storageId, { itemName = "", itemId = "", templateId = "", quantity = 1, quality = 0 }) {
  await requireCapability(await supportsStorageGiveItem(db), "Storage give-item requires compatible dune.inventories and dune.items insert columns.");
  const target = intParam(storageId, "storage id", 1);
  const resolvedTemplate = validateTemplateId(templateId || itemId || itemName);
  const stackSize = intParam(quantity, "quantity", 1, 1000000);
  const qualityLevel = intParam(quality, "quality", 0, 1000000);
  return db.transaction(async (tx) => {
    const storage = await tx.query(`
      select id, actor_id, coalesce(max_item_count, 0)::int as max_item_count, coalesce(max_item_volume, 0)::int as max_item_volume
      from dune.inventories
      where actor_id = $1
      order by id
      limit 1
      for update`, [target]);
    if (!storage.rows[0]) throw new Error("Storage inventory was not found for the selected storage actor");
    const inventory = storage.rows[0];
    const count = await tx.query("select count(*)::int as count from dune.items where inventory_id = $1", [inventory.id]);
    const currentCount = Number(count.rows[0]?.count || 0);
    if (inventory.max_item_count > 0 && currentCount >= inventory.max_item_count) throw new Error("Storage is full by item slot count");
    const position = await tx.query("select coalesce(max(position_index), -1)::int + 1 as position_index from dune.items where inventory_id = $1", [inventory.id]);
    const stats = {
      FCustomizationStats: [[], {}],
      FItemStackAndDurabilityStats: [[], {}]
    };
    const inserted = await tx.query(`
      insert into dune.items (inventory_id, template_id, stack_size, quality_level, position_index, stats)
      values ($1, $2, $3, $4, $5, $6::jsonb)
      returning id, template_id, stack_size, quality_level, position_index, inventory_id`, [
      inventory.id,
      resolvedTemplate,
      stackSize,
      qualityLevel,
      Number(position.rows[0]?.position_index || 0),
      JSON.stringify(stats)
    ]);
    return { ok: true, storage: inventory, inserted: inserted.rows[0] };
  });
}

export async function repairGear(db, id) {
  await requireCapability(await supportsRepairGear(db), "Repair gear requires dune.items.stats and dune.inventories.inventory_type.");
  return db.transaction(async (tx) => {
    const player = await resolvePlayerMutationTarget(tx, id);
    if (String(player.onlineStatus).toLowerCase() === "online") throw new Error("Repair gear requires the player to be offline so live state cannot overwrite the DB change");
    const items = await tx.query(`
      select i.id, i.stats
      from dune.items i
      join dune.inventories inv on inv.id = i.inventory_id
      where inv.actor_id = $1 and inv.inventory_type in (0, 1, 14, 15, 27, 30)
      for update`, [player.actorId]);
    let repaired = 0;
    for (const row of items.rows) {
      const stats = row.stats || {};
      const durability = stats.FItemStackAndDurabilityStats?.[1];
      if (!durability || typeof durability !== "object") continue;
      const target = repairTarget(durability);
      if (!target) continue;
      durability.CurrentDurability = target;
      durability.DecayedDurability = target;
      await tx.query("update dune.items set stats = $1::jsonb where id = $2", [JSON.stringify(stats), row.id]);
      repaired += 1;
    }
    return { ok: true, player, scanned: items.rows.length, repaired };
  });
}

export async function refuelVehicle(db, id, { vehicleId }) {
  await requireCapability(await supportsRefuelVehicle(db), "Refuel vehicle requires dune.actors.owner_account_id, class, and properties JSON.");
  const safeVehicleId = intParam(vehicleId, "vehicle id", 1);
  return db.transaction(async (tx) => {
    const player = await resolvePlayerMutationTarget(tx, id);
    if (String(player.onlineStatus).toLowerCase() === "online") throw new Error("Refuel vehicle requires the player to be offline so live state cannot overwrite the DB change");
    const vehicle = await tx.query(`
      select id, class, owner_account_id, properties
      from dune.actors
      where id = $1
      for update`, [safeVehicleId]);
    const row = vehicle.rows[0];
    if (!row) throw new Error("Vehicle actor was not found");
    if (Number(row.owner_account_id || 0) !== Number(player.accountId || 0)) throw new Error("Vehicle is not owned by the selected player's account");
    const bpClass = String(row.class || "").split(".").pop();
    if (!bpClass) throw new Error("Vehicle class could not be resolved");
    await tx.query(`
      update dune.actors
      set properties = jsonb_set(coalesce(properties, '{}'::jsonb), $1::text[], '1.0'::jsonb, true)
      where id = $2`, [[bpClass, "m_InitialFuel"], safeVehicleId]);
    return { ok: true, player, vehicle: { id: row.id, class: row.class } };
  });
}

async function playerCapabilities(db) {
  return {
    inventory: await tableExists(db, "items") && await tableExists(db, "inventories"),
    currency: await tableExists(db, "player_virtual_currency_balances"),
    factions: await tableExists(db, "player_faction_reputation"),
    specs: await tableExists(db, "specialization_tracks"),
    addCurrency: await supportsCurrencyMutation(db),
    addFactionReputation: await supportsFactionMutation(db),
    addIntel: await supportsIntelMutation(db),
    craftingRecipes: await supportsCraftingRecipes(db),
    researchItems: await supportsResearchItems(db),
    inventoryDelete: await supportsInventoryDelete(db),
    repairGear: await supportsRepairGear(db),
    refuelVehicle: await supportsRefuelVehicle(db),
    progression: false,
    events: false,
    stats: false,
    history: false
  };
}

async function supportsIntelMutation(db) {
  if (!(await tableExists(db, "actors"))) return false;
  const actorColumns = await columnsFor(db, "actors");
  return actorColumns.has("properties");
}

async function supportsCraftingRecipes(db) {
  if (!(await tableExists(db, "actors"))) return false;
  const actorColumns = await columnsFor(db, "actors");
  return actorColumns.has("properties");
}

async function supportsResearchItems(db) {
  if (!(await tableExists(db, "actors"))) return false;
  const actorColumns = await columnsFor(db, "actors");
  return actorColumns.has("properties");
}

async function supportsJourney(db) {
  return await tableExists(db, "journey_story_node") &&
    await tableExists(db, "player_tags") &&
    await supportsTutorials(db) &&
    await functionExists(db, "dune.update_player_tags(bigint,text[],text[])");
}

async function supportsTutorials(db) {
  return await tableExists(db, "tutorials") &&
    await tableExists(db, "tutorial_per_player") &&
    await functionExists(db, "dune.create_or_update_tutorial_entry(bigint,smallint,smallint)");
}

function validateJourneyNodeId(value) {
  const nodeId = String(value || "").trim();
  if (!nodeId || nodeId.length > 500 || /[\r\n]/.test(nodeId)) throw new Error("Journey node ID is invalid");
  return nodeId;
}

function journeyGroup(nodeId) {
  const value = String(nodeId || "");
  if (/^DA_(CT|LDR)_/.test(value)) return "contract";
  return "story";
}

function journeyNodeRow(nodeId, category, state, tagMap, allNodeIds) {
  const nodeState = state.get(nodeId) || {};
  return {
    id: nodeId,
    name: journeyDisplayName(nodeId),
    rawName: nodeId,
    category,
    depth: journeyDepth(nodeId, allNodeIds),
    parentId: journeyParentId(nodeId, allNodeIds),
    status: nodeState.complete ? "Complete" : nodeState.revealed ? "Revealed" : "Incomplete",
    complete: Boolean(nodeState.complete),
    revealed: Boolean(nodeState.revealed),
    pendingReward: Boolean(nodeState.pendingReward),
    tags: Array.isArray(tagMap?.[nodeId]) ? tagMap[nodeId].length : 0,
    dependency: journeyParentId(nodeId, allNodeIds) || ""
  };
}

function contractNodeRow(nodeId, contractTags, contractAliases, tagState) {
  const tags = Array.isArray(contractTags?.[nodeId]) ? contractTags[nodeId] : [];
  const shortName = Object.entries(contractAliases || {}).find(([, full]) => full === nodeId)?.[0] || nodeId.replace(/^DA_CT_/, "");
  const complete = tags.length > 0 && tags.every((tag) => tagState.has(String(tag)));
  return {
    id: nodeId,
    name: journeyDisplayName(shortName),
    rawName: shortName,
    category: "Contract",
    depth: 0,
    parentId: "",
    status: complete ? "Complete" : "Incomplete",
    complete,
    revealed: false,
    pendingReward: false,
    tags: tags.length,
    dependency: ""
  };
}

function isContractNode(nodeId, journeyTagsData = {}) {
  const contractTags = journeyTagsData?.contract_tags || {};
  return Array.isArray(contractTags[nodeId]);
}

function contractTagsForNode(nodeId, journeyTagsData = {}) {
  const contractTags = journeyTagsData?.contract_tags || {};
  const tags = contractTags[nodeId];
  if (!Array.isArray(tags) || !tags.length) throw new Error(`Contract ${nodeId} was not found in the game data catalog.`);
  return tags.map((tag) => String(tag || "").trim()).filter(Boolean);
}

function journeyParentId(nodeId, allNodeIds) {
  const ids = new Set(allNodeIds);
  const parts = String(nodeId || "").split(".");
  while (parts.length > 1) {
    parts.pop();
    const parent = parts.join(".");
    if (ids.has(parent)) return parent;
  }
  return "";
}

function journeyDepth(nodeId, allNodeIds) {
  let depth = 0;
  let parent = journeyParentId(nodeId, allNodeIds);
  while (parent) {
    depth += 1;
    parent = journeyParentId(parent, allNodeIds);
  }
  return depth;
}

function journeyDisplayName(value) {
  const raw = String(value || "").split(".").pop() || String(value || "");
  return raw
    .replace(/^(DA_|CT_|LDR_|FQ_|Dunipedia_)/, "")
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z0-9])/g, "$1 $2")
    .replace(/([0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim() || String(value || "");
}

function tutorialStatus(value) {
  if (Number(value) === 2) return "Complete";
  if (Number(value) === 1) return "Started";
  return "Not Started";
}

function tagsForJourneyNodeSubtree(nodeId, journeyTagsData = {}) {
  const tagMap = journeyTagsData?.journey_node_tags || {};
  const prefix = `${nodeId}.`;
  const seen = new Set();
  const tags = [];
  const add = (items = []) => {
    for (const item of items) {
      const tag = String(item || "").trim();
      if (tag && !seen.has(tag)) {
        seen.add(tag);
        tags.push(tag);
      }
    }
  };
  add(tagMap[nodeId]);
  for (const [id, items] of Object.entries(tagMap)) {
    if (String(id).startsWith(prefix)) add(items);
  }
  return tags;
}

const FACTION_TIER_THRESHOLDS = [0, 99, 249, 499, 999, 1999, 2224, 2524, 2899, 3349, 3874, 4474, 5149, 5899, 6724, 7624, 8599, 9649, 10774, 11974, 12474];

function factionTierBumps(tags) {
  const out = new Map();
  for (const tag of tags) {
    const match = /^Faction\.([A-Za-z]+)\.Tier([0-5])$/.exec(String(tag || ""));
    if (!match) continue;
    const tier = Number(match[2]);
    const rep = tier > 0 ? FACTION_TIER_THRESHOLDS[tier] + 1 : 0;
    const current = out.get(match[1]) || 0;
    if (rep > current) out.set(match[1], rep);
  }
  return out;
}

function factionIdByName(name) {
  if (name === "Atreides") return 1;
  if (name === "Harkonnen") return 2;
  if (name === "None") return 3;
  if (name === "Smuggler") return 4;
  return 0;
}

async function applyJourneyTags(db, player, tags, mode) {
  if (!tags.length) return { factionBumps: 0 };
  if (mode === "remove") {
    await db.query("select dune.update_player_tags($1, '{}'::text[], $2::text[])", [player.accountId, tags]);
    return { factionBumps: 0 };
  }
  await db.query("select dune.update_player_tags($1, $2::text[], '{}'::text[])", [player.accountId, tags]);
  const bumps = factionTierBumps(tags);
  let factionBumps = 0;
  for (const [name, rep] of bumps.entries()) {
    const factionId = factionIdByName(name);
    if (!factionId) continue;
    const current = await db.query(`
      select coalesce(reputation_amount, 0) as reputation_amount
      from dune.player_faction_reputation
      where actor_id = $1 and faction_id = $2`, [player.controllerId, factionId]);
    if (Number(current.rows[0]?.reputation_amount || 0) >= rep) continue;
    await db.query("select dune.set_player_faction_reputation($1::bigint, $2::smallint, $3::integer)", [player.controllerId, factionId, rep]);
    factionBumps += 1;
  }
  if (factionBumps > 0) await syncFactionComponent(db, player.controllerId);
  return { factionBumps };
}

function validateRecipeId(value) {
  const recipeId = String(value || "").trim();
  if (!/^[A-Za-z0-9_().-]+$/.test(recipeId)) throw new Error("Crafting recipe ID is invalid");
  return recipeId;
}

function recipeDisplayName(recipeId) {
  return String(recipeId || "")
    .replace(/_?recipe$/i, "")
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z0-9])/g, "$1 $2")
    .replace(/([0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim() || recipeId;
}

function recipeCategory(recipeId) {
  const value = String(recipeId || "").toLowerCase();
  if (/(buggy|sandbike|vehicle|treadwheel|ornithopter|sandcrawler)/.test(value)) return "Vehicles";
  if (/(stillsuit|literjon|bloodsack|blood_sack|bodyfluid|dew|water|stilltent)/.test(value)) return "Water Discipline";
  if (/(ammo|rifle|pistol|shotgun|smg|weapon|lasgun|flamethrower|staticcompactor|kindjal|crysknife|knife|sword|shield|napalm|disruptor)/.test(value)) return "Combat";
  if (/(building|basebackup|portablelight|decajon|totem|refinery|container|fabricator|placeable|structure)/.test(value)) return "Construction";
  if (/(scanner|powerpack|radiation|cutteray|miningtool|mining_tool|thumper|suspensor|fuel|harvester)/.test(value)) return "Exploration";
  return "Essentials";
}

function validateResearchKey(value) {
  const itemKey = String(value || "").trim();
  if (!/^[A-Za-z0-9_().+\-]+$/.test(itemKey)) throw new Error("Research key is invalid");
  return itemKey;
}

function researchRecipeId(itemKey) {
  const value = String(itemKey || "");
  return value.startsWith("RCP_") ? value.slice(4) : "";
}

async function materializeCraftingRecipeIfKnown(db, actorId, recipeId) {
  if (!recipeId) return false;
  const known = await db.query(`
    select exists (
      select 1
      from dune.actors a
      cross join lateral jsonb_array_elements(coalesce(a.properties->'CraftingRecipesLibraryActorComponent'->'m_KnownItemRecipes', '[]'::jsonb)) recipe
      where recipe->'BaseRecipeId'->>'Name' = $1
    ) as exists`, [recipeId]);
  if (!known.rows[0]?.exists) return false;
  const current = await db.query(`
    select properties->'CraftingRecipesLibraryActorComponent'->'m_KnownItemRecipes' as recipes
    from dune.actors
    where id = $1 and properties ? 'CraftingRecipesLibraryActorComponent'
    for update`, [actorId]);
  if (!current.rows.length) return false;
  const recipes = Array.isArray(current.rows[0]?.recipes) ? current.rows[0].recipes : [];
  if (recipes.some((recipe) => recipe?.BaseRecipeId?.Name === recipeId)) return false;
  const nextRecipes = [...recipes, {
    m_Source: "SchematicPickup",
    m_bIsNew: true,
    BaseRecipeId: { Name: recipeId },
    m_QualityLevel: 0,
    m_NumberOfRecipeUses: 0,
    m_bIsLimitedUseRecipe: false
  }];
  await db.query(`
    update dune.actors
    set properties = jsonb_set(properties, '{CraftingRecipesLibraryActorComponent,m_KnownItemRecipes}', $2::jsonb, true)
    where id = $1 and properties ? 'CraftingRecipesLibraryActorComponent'`, [actorId, JSON.stringify(nextRecipes)]);
  return true;
}

function researchDisplayName(itemKey) {
  return String(itemKey || "")
    .replace(/^(RCP_|DA_GRP_|BLD_)/, "")
    .replace(/_?Patent$/i, "")
    .replace(/_?Recipe$/i, "")
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z0-9])/g, "$1 $2")
    .replace(/([0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim() || itemKey;
}

function researchType(itemKey) {
  const value = String(itemKey || "");
  if (value.startsWith("RCP_")) return "Recipe";
  if (value.startsWith("BLD_")) return "Building";
  if (value.startsWith("DA_GRP_")) return "Group";
  return "Research";
}

function researchCategory(itemKey) {
  const value = String(itemKey || "").toLowerCase();
  if (/(unique|recyclerdummy)/.test(value)) return "Uniques";
  if (/(vehicle|sandbike|buggy|orni|ornithopter|thopter|repairtool|welding|fuel)/.test(value)) return "Vehicles";
  if (/(stillsuit|literjon|blood|dew|water|windtrap|cistern|exsanguination|stilltent)/.test(value)) return "Water Discipline";
  if (/(armor|ammo|rifle|pistol|shotgun|smg|lmg|weapon|lasgun|compactor|kindjal|crysknife|knife|sword|shield|napalm|dirk|rapier|rocket)/.test(value)) return "Combat";
  if (/(bld_|building|shelter|totem|generator|lighting|silo|fabricator|refinery|container|staking|pentashield|turbine|spice)/.test(value)) return "Construction";
  if (/(scanner|binocular|powerpack|radiation|cutteray|mining|thumper|suspensor|probe|spice|stabilization)/.test(value)) return "Exploration";
  if (/(augment)/.test(value)) return "Augmentations";
  return "Essentials";
}

function researchProductGroup(itemKey, category = "") {
  const value = String(itemKey || "").toLowerCase();
  if (/(t6|plastanium|regis)/.test(value)) return "Plastanium Products";
  if (/(t5|duraluminum|duraluminium)/.test(value)) return "Duraluminum Products";
  if (/(t4|aluminum|aluminium)/.test(value)) return "Aluminum Products";
  if (/(t3|steel)/.test(value)) return "Steel Products";
  if (/(t2|iron)/.test(value)) return "Iron Products";
  if (/(copper)/.test(value)) return "Copper Products";
  if (/(augment)/.test(value)) return "Generic Augmentations";
  if (category === "Uniques") return "Copper Products";
  if (category === "Vehicles") return "Copper Products";
  return "Salvage Products";
}

async function supportsCurrencyMutation(db) {
  return await tableExists(db, "player_virtual_currency_balances") &&
    await functionExists(db, "dune.adjust_player_virtual_currency_balance(bigint,smallint,bigint)");
}

async function supportsFactionMutation(db) {
  if (!(await tableExists(db, "player_faction_reputation")) || !(await tableExists(db, "actors"))) return false;
  const actorColumns = await columnsFor(db, "actors");
  return actorColumns.has("properties") &&
    await functionExists(db, "dune.set_player_faction_reputation(bigint,smallint,integer)");
}

async function supportsInventoryDelete(db) {
  return await tableExists(db, "items") &&
    await tableExists(db, "inventories") &&
    await functionExists(db, "dune.delete_item(bigint)");
}

async function supportsStorageGiveItem(db) {
  if (!(await tableExists(db, "items")) || !(await tableExists(db, "inventories"))) return false;
  const inventoryColumns = await columnsFor(db, "inventories");
  const itemColumns = await columnsFor(db, "items");
  return ["id", "actor_id", "max_item_count", "max_item_volume"].every((column) => inventoryColumns.has(column)) &&
    ["inventory_id", "template_id", "stack_size", "quality_level", "position_index", "stats"].every((column) => itemColumns.has(column));
}

async function supportsRepairGear(db) {
  if (!(await tableExists(db, "items")) || !(await tableExists(db, "inventories"))) return false;
  const inventoryColumns = await columnsFor(db, "inventories");
  const itemColumns = await columnsFor(db, "items");
  return inventoryColumns.has("inventory_type") && itemColumns.has("stats");
}

async function supportsRefuelVehicle(db) {
  if (!(await tableExists(db, "actors"))) return false;
  const actorColumns = await columnsFor(db, "actors");
  return ["id", "class", "owner_account_id", "properties"].every((column) => actorColumns.has(column));
}

async function functionExists(db, signature) {
  const result = await db.query("select to_regprocedure($1) is not null as exists", [signature]);
  return Boolean(result.rows[0]?.exists);
}

async function requireCapability(supported, reason) {
  if (!supported) throw new UnsupportedCapabilityError(reason);
}

async function resolvePlayerMutationTarget(db, id) {
  const actorId = intParam(id, "player id", 1);
  const result = await db.query(`
    select a.id as actor_id,
           coalesce(a.owner_account_id, ps.account_id, 0) as account_id,
           coalesce(ps.player_controller_id, a.id) as controller_id,
           coalesce(ps.online_status::text, 'Offline') as online_status
    from dune.actors a
    left join dune.player_state ps on ps.player_pawn_id = a.id or ps.account_id = a.owner_account_id
    where a.id = $1
    limit 1`, [actorId]);
  const row = result.rows[0];
  if (!row) throw new Error("Player not found");
  return {
    actorId: Number(row.actor_id),
    accountId: Number(row.account_id || 0),
    controllerId: Number(row.controller_id || row.actor_id),
    onlineStatus: row.online_status || "Offline"
  };
}

async function resolveCurrencyId(db, currencyId) {
  const raw = String(currencyId ?? "0").trim().toLowerCase();
  if (!raw || raw === "0" || raw === "solaris") {
    if (!(await functionExists(db, "dune.get_solaris_id()"))) {
      throw new UnsupportedCapabilityError("Solaris currency requires dune.get_solaris_id() in this schema.");
    }
    const result = await db.query("select dune.get_solaris_id()::int as currency_id");
    return intParam(result.rows[0]?.currency_id, "currency id", 0, 32767);
  }
  return intParam(raw, "currency id", 0, 32767);
}

async function syncFactionComponent(db, actorId) {
  const result = await db.query(`
    select faction_id, reputation_amount
    from dune.player_faction_reputation
    where actor_id = $1 and faction_id in (1, 2)`, [actorId]);
  const reps = new Map(result.rows.map((row) => [Number(row.faction_id), Number(row.reputation_amount || 0)]));
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = [
    { Faction: { Name: "Atreides" }, timestamp, ReputationAmount: reps.get(1) || 0 },
    { Faction: { Name: "Harkonnen" }, timestamp, ReputationAmount: reps.get(2) || 0 }
  ];
  await db.query(`
    update dune.actors
    set properties = jsonb_set(coalesce(properties, '{}'::jsonb), '{FactionPlayerComponent,m_FactionDataArray}', $1::jsonb, true)
    where id = $2`, [JSON.stringify(payload), actorId]);
}

function validateTemplateId(value) {
  const raw = String(value || "").trim();
  if (/^[A-Za-z0-9_./:-]{1,240}$/.test(raw)) return raw;
  throw new Error("Invalid item template/id");
}

function repairTarget(durability) {
  const max = Number(durability.MaxDurability);
  const current = Number(durability.CurrentDurability || 0);
  const decayed = Number(durability.DecayedDurability || 0);
  const target = Number.isFinite(max) && max > 0 ? max : Math.max(current, decayed, 100);
  if (!Number.isFinite(target) || target <= 0) return 0;
  if (current >= target && decayed >= target) return 0;
  return target;
}

function validateMapName(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^[A-Za-z0-9_:-]{1,80}$/.test(raw)) return raw;
  throw new Error("Invalid map name");
}

function mapFilterClause(map, values, alias) {
  const safe = validateMapName(map);
  if (!safe) return "";
  values.push(safe);
  return ` and ${alias}.map = $${values.length}`;
}

function normalizeMarker(row) {
  return {
    ...row,
    id: Number(row.id),
    partition_id: Number(row.partition_id || 0),
    x: Number(row.x),
    y: Number(row.y),
    z: Number(row.z)
  };
}

function unsupportedMap(feature, requiredTables) {
  return {
    capabilities: { [feature]: false },
    rows: [],
    reason: `Unsupported by detected schema. Missing required table(s): ${requiredTables.join(", ")}`
  };
}

function unsupported(feature, requiredTables) {
  return {
    capabilities: { [feature]: false },
    rows: [],
    reason: `Unsupported by detected schema. Missing required table(s): ${requiredTables.join(", ")}`
  };
}
