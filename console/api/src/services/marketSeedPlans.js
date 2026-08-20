// Named Market Bot seed plans: operators keep the bundled catalog as a
// read-only baseline and can store additional CSV-backed lists, pick one as
// the active seeding catalog, and download/upload that list. Custom plans live
// under runtime/generated/market-bot/plans/ and never overwrite the shipped
// runtime/data/market-seed-plan.json.
//
// Seed and buyback jobs resolve the active plan through
// resolveActiveMarketSeedPlanPath; unsafe template ids always come from the
// shipped plan so a CSV cannot un-block NPC-only / story items.

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { writeJsonAtomic } from "../jsonStore.js";
import { readUnsafeTemplateIds } from "./marketItemOverrides.js";

export const BUNDLED_SEED_PLAN_ID = "bundled";
export const MAX_CUSTOM_SEED_PLANS = 25;
export const MAX_SEED_PLAN_NAME_LENGTH = 80;
export const MAX_SEED_PLAN_BYTES = 10 * 1024 * 1024;
export const MAX_SEED_PLAN_ROWS = 20000;

const EDA_EXCHANGE_BOT_ADDON_ID = "eda-exchange-bot";
const PLANS_DIR = "runtime/generated/market-bot/plans";
const INDEX_FILE = "runtime/generated/market-bot/plans.json";
const PLAN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const SEED_PLAN_CSV_COLUMNS = [
  "template_id",
  "display_name",
  "kind",
  "stack_size",
  "price",
  "category_mask",
  "category_depth",
  "quality_level",
  "special_boost",
  "listings",
  "durability_cur",
  "durability_max"
];

const CSV_HEADER_ALIASES = {
  template_id: "template_id",
  templateid: "template_id",
  id: "template_id",
  display_name: "display_name",
  displayname: "display_name",
  name: "display_name",
  kind: "kind",
  seed_kind: "kind",
  stack_size: "stack_size",
  stacksize: "stack_size",
  stack: "stack_size",
  price: "price",
  item_price: "price",
  category_mask: "category_mask",
  categorymask: "category_mask",
  category_depth: "category_depth",
  categorydepth: "category_depth",
  quality_level: "quality_level",
  qualitylevel: "quality_level",
  quality: "quality_level",
  grade: "quality_level",
  special_boost: "special_boost",
  specialboost: "special_boost",
  listings: "listings",
  listing_count: "listings",
  durability_cur: "durability_cur",
  durabilitycur: "durability_cur",
  durability: "durability_cur",
  durability_max: "durability_max",
  durabilitymax: "durability_max"
};

const AUGMENT_TEMPLATE_PATTERN = /^T\d+_Augment_/i;

let planSummaryCache = null;

export function resolveShippedMarketSeedPlanPath(config, addonId = EDA_EXCHANGE_BOT_ADDON_ID) {
  const bundledPath = resolve(config.repoRoot, "runtime/data/market-seed-plan.json");
  if (existsSync(bundledPath)) return bundledPath;
  const addonPath = resolve(config.repoRoot, "runtime/addons/installed", addonId, "web", "market-seed-plan.json");
  if (existsSync(addonPath)) return addonPath;
  return null;
}

export function resolveActiveMarketSeedPlanPath(config, addonId = EDA_EXCHANGE_BOT_ADDON_ID) {
  const index = readPlanIndex(config);
  if (index.activePlanId && index.activePlanId !== BUNDLED_SEED_PLAN_ID) {
    const customPath = customPlanFilePath(config, index.activePlanId);
    if (existsSync(customPath)) return customPath;
  }
  return resolveShippedMarketSeedPlanPath(config, addonId);
}

export function marketSeedPlanSummary(config) {
  const path = resolveActiveMarketSeedPlanPath(config);
  const catalog = listMarketSeedPlans(config);
  const active = catalog.items.find((item) => item.id === catalog.activePlanId) || catalog.items[0] || null;
  if (!path) {
    return {
      available: false,
      source: null,
      rows: 0,
      panelVersion: "",
      generatedAt: "",
      id: catalog.activePlanId || BUNDLED_SEED_PLAN_ID,
      name: active?.name || "Bundled"
    };
  }
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  const cacheKey = `${path}\0${mtimeMs}\0${catalog.activePlanId}\0${active?.name || ""}`;
  if (planSummaryCache && planSummaryCache.cacheKey === cacheKey) return planSummaryCache.summary;
  let summary;
  try {
    const plan = parsePlanJson(readFileSync(path, "utf8"), path);
    const source = path.includes(`${PLANS_DIR}/`)
      ? "custom"
      : path.includes("runtime/addons/installed")
        ? "addon"
        : "bundled";
    summary = {
      available: Array.isArray(plan.rows) && plan.rows.length > 0,
      source,
      rows: Array.isArray(plan.rows) ? plan.rows.length : 0,
      panelVersion: String(plan.panel_version || ""),
      generatedAt: String(plan.generated_at || ""),
      id: source === "custom" ? catalog.activePlanId : BUNDLED_SEED_PLAN_ID,
      name: source === "custom" ? (active?.name || String(plan.name || "Custom plan")) : (active?.name || (source === "addon" ? "Addon" : "Bundled"))
    };
  } catch {
    summary = {
      available: false,
      source: path.includes(`${PLANS_DIR}/`) ? "custom" : null,
      rows: 0,
      panelVersion: "",
      generatedAt: "",
      id: catalog.activePlanId,
      name: active?.name || "Seed plan"
    };
  }
  planSummaryCache = { cacheKey, summary };
  return summary;
}

export function listMarketSeedPlans(config) {
  const shippedPath = resolveShippedMarketSeedPlanPath(config);
  const index = readPlanIndex(config);
  const items = [];
  if (shippedPath) {
    items.push(summarizeShippedPlan(shippedPath));
  }
  for (const entry of index.plans) {
    const path = customPlanFilePath(config, entry.id);
    if (!existsSync(path)) continue;
    items.push({
      id: entry.id,
      name: entry.name,
      source: "custom",
      readOnly: false,
      rows: Number(entry.rowCount) || 0,
      panelVersion: "",
      generatedAt: String(entry.updatedAt || entry.createdAt || ""),
      active: false
    });
  }
  const activePlanId = resolveListedActivePlanId(index.activePlanId, items);
  return {
    activePlanId,
    items: items.map((item) => ({ ...item, active: item.id === activePlanId }))
  };
}

export function setActiveMarketSeedPlan(config, planId) {
  const id = String(planId || "").trim();
  const catalog = listMarketSeedPlans(config);
  const match = catalog.items.find((item) => item.id === id);
  if (!match) throw new Error("Unknown seed plan.");
  if (id !== BUNDLED_SEED_PLAN_ID && !existsSync(customPlanFilePath(config, id))) {
    throw new Error("That seed plan file is missing. Choose another plan or re-upload the CSV.");
  }
  const index = readPlanIndex(config);
  writePlanIndex(config, { ...index, activePlanId: id });
  planSummaryCache = null;
  return listMarketSeedPlans(config);
}

export function renameMarketSeedPlan(config, planId, name) {
  const id = String(planId || "").trim();
  if (!id || id === BUNDLED_SEED_PLAN_ID) throw new Error("The bundled seed plan name cannot be changed.");
  const nextName = normalizePlanName(name);
  const index = readPlanIndex(config);
  const entry = index.plans.find((plan) => plan.id === id);
  if (!entry) throw new Error("Unknown seed plan.");
  const path = customPlanFilePath(config, id);
  if (!existsSync(path)) throw new Error("That seed plan file is missing. Choose another plan or re-upload the CSV.");
  const plan = parsePlanJson(readFileSync(path, "utf8"), path);
  const updatedAt = new Date().toISOString();
  writeJsonAtomic(path, { ...plan, id, name: nextName }, 0o600, { pretty: false });
  writePlanIndex(config, {
    ...index,
    plans: index.plans.map((planEntry) => (
      planEntry.id === id ? { ...planEntry, name: nextName, updatedAt } : planEntry
    ))
  });
  planSummaryCache = null;
  return listMarketSeedPlans(config);
}

export function exportMarketSeedPlanCsv(config, planId) {
  const id = String(planId || "").trim() || readPlanIndex(config).activePlanId || BUNDLED_SEED_PLAN_ID;
  const catalog = listMarketSeedPlans(config);
  const match = catalog.items.find((item) => item.id === id);
  if (!match) throw new Error("Unknown seed plan.");
  const path = id === BUNDLED_SEED_PLAN_ID
    ? resolveShippedMarketSeedPlanPath(config)
    : customPlanFilePath(config, id);
  if (!path || !existsSync(path)) throw new Error("That seed plan file is missing.");
  const plan = parsePlanJson(readFileSync(path, "utf8"), path);
  const rows = Array.isArray(plan.rows) ? plan.rows : [];
  const csv = stringifySeedPlanCsv(rows);
  const filename = `market-seed-${slugifyPlanName(match.name || id)}.csv`;
  return { id, name: match.name, filename, csv, rows: rows.length };
}

export function importMarketSeedPlanFromCsv(config, { csvText, name, planId, fileName } = {}) {
  const text = String(csvText || "");
  if (!text.trim()) throw new Error("The uploaded CSV is empty.");
  if (Buffer.byteLength(text, "utf8") > MAX_SEED_PLAN_BYTES) throw new Error("Seed plan CSV is too large.");

  const shippedPath = resolveShippedMarketSeedPlanPath(config);
  const shipped = shippedPath ? parsePlanJson(readFileSync(shippedPath, "utf8"), shippedPath) : { rows: [] };
  const unsafeIds = readUnsafeTemplateIds(config.repoRoot);
  const rows = csvToPlanRows(text, shipped, unsafeIds);
  if (!rows.length) throw new Error("The uploaded CSV has no seed rows.");

  const index = readPlanIndex(config);
  const requestedId = String(planId || "").trim();
  const requestedName = String(name || "").trim();
  let targetId = "";
  let existing = null;

  if (requestedId && requestedId !== BUNDLED_SEED_PLAN_ID) {
    existing = index.plans.find((plan) => plan.id === requestedId) || null;
    if (!existing) throw new Error("Unknown seed plan.");
    targetId = existing.id;
  } else if (requestedName) {
    const normalized = normalizePlanName(requestedName);
    existing = index.plans.find((plan) => plan.name.toLowerCase() === normalized.toLowerCase()) || null;
    targetId = existing ? existing.id : newPlanId(normalized, new Set(index.plans.map((plan) => plan.id)));
  } else {
    throw new Error("Enter a friendly name for the imported seed plan.");
  }

  const planName = requestedName ? normalizePlanName(requestedName) : existing.name;
  if (!existing && index.plans.length >= MAX_CUSTOM_SEED_PLANS) {
    throw new Error(`At most ${MAX_CUSTOM_SEED_PLANS} named seed plans can be stored.`);
  }

  const generatedAt = new Date().toISOString();
  const plan = {
    id: targetId,
    name: planName,
    generated_at: generatedAt,
    panel_version: shipped.panel_version || "",
    price_multiplier: Math.max(1, Number(shipped.price_multiplier) || 5),
    market_bot_class: shipped.market_bot_class || "Revy",
    imported_from: String(fileName || "").slice(0, 200),
    rows
  };
  writeJsonAtomic(customPlanFilePath(config, targetId), plan, 0o600, { pretty: false });
  const entry = {
    id: targetId,
    name: planName,
    rowCount: rows.length,
    createdAt: existing?.createdAt || generatedAt,
    updatedAt: generatedAt
  };
  const plans = existing
    ? index.plans.map((planEntry) => (planEntry.id === targetId ? entry : planEntry))
    : [...index.plans, entry];
  writePlanIndex(config, { activePlanId: targetId, plans });
  planSummaryCache = null;
  return {
    id: targetId,
    name: planName,
    rows: rows.length,
    active: true,
    plans: listMarketSeedPlans(config)
  };
}

export function stringifySeedPlanCsv(rows) {
  const lines = [SEED_PLAN_CSV_COLUMNS.join(",")];
  for (const row of rows || []) {
    lines.push(SEED_PLAN_CSV_COLUMNS.map((column) => csvEscape(csvCellValue(row, column))).join(","));
  }
  return `\uFEFF${lines.join("\n")}\n`;
}

export function parseCsv(text) {
  const source = String(text || "").replace(/^\uFEFF/, "");
  if (!source.trim()) return [];
  const delimiter = detectCsvDelimiter(source);
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      if (field.endsWith("\r")) field = field.slice(0, -1);
      row.push(field);
      if (row.some((value) => String(value).trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (inQuotes) throw new Error("CSV has an unclosed quoted field.");
  if (field.length || row.length) {
    if (field.endsWith("\r")) field = field.slice(0, -1);
    row.push(field);
    if (row.some((value) => String(value).trim() !== "")) rows.push(row);
  }
  return rows;
}

export function csvToPlanRows(csvText, shippedPlan = { rows: [] }, unsafeIds = []) {
  const table = parseCsv(csvText);
  if (table.length < 2) throw new Error("CSV must include a header row and at least one seed row.");
  const headers = table[0].map((header) => normalizeCsvHeader(header));
  if (!headers.includes("template_id")) {
    throw new Error("CSV must include a template_id column.");
  }
  const shippedRows = Array.isArray(shippedPlan?.rows) ? shippedPlan.rows : [];
  const bundledByKey = new Map();
  const bundledByTemplate = new Map();
  for (const row of shippedRows) {
    const templateId = String(row?.template_id || "").trim();
    if (!templateId) continue;
    const qualityLevel = clampInt(row?.quality_level, 0, 0, 5);
    bundledByKey.set(rowKey(templateId, qualityLevel), row);
    if (!bundledByTemplate.has(templateId)) bundledByTemplate.set(templateId, []);
    bundledByTemplate.get(templateId).push(row);
  }
  const unsafeSet = new Set((unsafeIds || []).map(String));
  const out = [];
  const seen = new Set();
  const unsafeHits = [];

  for (let index = 1; index < table.length; index += 1) {
    if (out.length >= MAX_SEED_PLAN_ROWS) {
      throw new Error(`Seed plan CSV cannot contain more than ${MAX_SEED_PLAN_ROWS} rows.`);
    }
    const record = rowToRecord(headers, table[index]);
    const templateId = String(record.template_id || "").trim();
    if (!templateId) continue;
    if (templateId.length > 200) throw new Error(`CSV row ${index + 1} has an invalid template_id.`);
    if (unsafeSet.has(templateId)) {
      unsafeHits.push(templateId);
      continue;
    }
    const hasQuality = record.quality_level !== undefined && String(record.quality_level).trim() !== "";
    const bases = hasQuality
      ? [bundledByKey.get(rowKey(templateId, clampInt(record.quality_level, 0, 0, 5))) || null]
      : (bundledByTemplate.get(templateId) || [null]);
    for (const base of bases) {
      const merged = mergeImportedRow(record, base, index + 1);
      const key = rowKey(merged.template_id, merged.quality_level);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(merged);
    }
  }

  if (unsafeHits.length) {
    const sample = [...new Set(unsafeHits)].slice(0, 5).join(", ");
    throw new Error(`CSV includes unsafe template id(s) that cannot be seeded: ${sample}.`);
  }
  const rows = addMissingAugmentItems(out, bundledByKey);
  assertAugmentSchematicGrades(rows);
  return rows;
}

function assertAugmentSchematicGrades(rows) {
  const itemGrades = new Set(rows
    .filter((row) => row.kind === "equippable" && AUGMENT_TEMPLATE_PATTERN.test(row.template_id))
    .map((row) => rowKey(row.template_id, row.quality_level)));
  for (const row of rows) {
    if (row.kind !== "schematic" || !AUGMENT_TEMPLATE_PATTERN.test(row.template_id) || !row.template_id.endsWith("_Schematic")) continue;
    const itemTemplateId = row.template_id.slice(0, -"_Schematic".length);
    if (!itemGrades.has(rowKey(itemTemplateId, row.quality_level))) {
      throw new Error(`CSV has augment schematic ${row.template_id} quality ${row.quality_level} without a matching augmentation item.`);
    }
  }
}

function mergeImportedRow(record, base, rowNumber) {
  const templateId = String(record.template_id || base?.template_id || "").trim();
  const qualityLevel = clampInt(
    firstDefined(record.quality_level, base?.quality_level),
    0,
    0,
    5
  );
  const price = Number(firstDefined(record.price, base?.price));
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`CSV row ${rowNumber} (${templateId}) is missing a valid price and is not in the bundled seed plan.`);
  }
  const listings = Math.max(1, Math.trunc(Number(firstDefined(record.listings, base?.listings)) || 1));
  const stackSize = Math.max(1, Math.trunc(Number(firstDefined(record.stack_size, base?.stack_size)) || 1));
  const kind = String(firstDefined(record.kind, base?.kind) || "equippable").slice(0, 40);
  const displayName = String(firstDefined(record.display_name, base?.display_name) || templateId).slice(0, 200);
  const durabilityMax = clampInt(firstDefined(record.durability_max, base?.durability_max, base?.durability_cur, 100), 100, 100, 200);
  const durabilityCur = Math.min(
    clampInt(firstDefined(record.durability_cur, base?.durability_cur, durabilityMax), durabilityMax, 100, 200),
    durabilityMax
  );
  return {
    ...(base && typeof base === "object" ? base : {}),
    template_id: templateId,
    display_name: displayName,
    kind,
    stack_size: stackSize,
    price,
    category_mask: Math.trunc(Number(firstDefined(record.category_mask, base?.category_mask)) || 0),
    category_depth: clampInt(firstDefined(record.category_depth, base?.category_depth), 1, 0, 4),
    quality_level: qualityLevel,
    special_boost: parseBoolean(firstDefined(record.special_boost, base?.special_boost), false),
    listings,
    durability_cur: durabilityCur,
    durability_max: durabilityMax
  };
}

function addMissingAugmentItems(rows, bundledByKey) {
  const present = new Set(rows.map((row) => rowKey(row.template_id, row.quality_level)));
  const extra = [];
  for (const row of rows) {
    if (row.kind !== "schematic" || !AUGMENT_TEMPLATE_PATTERN.test(row.template_id) || !row.template_id.endsWith("_Schematic")) continue;
    const itemTemplateId = row.template_id.slice(0, -"_Schematic".length);
    const key = rowKey(itemTemplateId, row.quality_level);
    if (present.has(key)) continue;
    const bundled = bundledByKey.get(key);
    if (!bundled) continue;
    extra.push(mergeImportedRow({ template_id: itemTemplateId, quality_level: row.quality_level }, bundled, 0));
    present.add(key);
  }
  return extra.length ? [...rows, ...extra] : rows;
}

function summarizeShippedPlan(path) {
  const source = path.includes("runtime/addons/installed") ? "addon" : "bundled";
  try {
    const plan = parsePlanJson(readFileSync(path, "utf8"), path);
    return {
      id: BUNDLED_SEED_PLAN_ID,
      name: source === "addon" ? "Addon" : "Bundled",
      source,
      readOnly: true,
      rows: Array.isArray(plan.rows) ? plan.rows.length : 0,
      panelVersion: String(plan.panel_version || ""),
      generatedAt: String(plan.generated_at || ""),
      active: false
    };
  } catch {
    return {
      id: BUNDLED_SEED_PLAN_ID,
      name: source === "addon" ? "Addon" : "Bundled",
      source,
      readOnly: true,
      rows: 0,
      panelVersion: "",
      generatedAt: "",
      active: false
    };
  }
}

function parsePlanJson(text, path) {
  if (text.length > MAX_SEED_PLAN_BYTES) throw new Error("Market seed plan is too large.");
  let plan;
  try {
    plan = JSON.parse(text);
  } catch {
    throw new Error(`Market seed plan is not valid JSON (${path}).`);
  }
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw new Error("Market seed plan must be a JSON object.");
  }
  return plan;
}

function readPlanIndex(config) {
  const file = resolve(config.repoRoot, INDEX_FILE);
  if (!existsSync(file)) return { activePlanId: BUNDLED_SEED_PLAN_ID, plans: [] };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const plans = [];
    const seen = new Set();
    if (Array.isArray(raw?.plans)) {
      for (const entry of raw.plans) {
        const id = String(entry?.id || "").trim();
        if (!PLAN_ID_PATTERN.test(id) || id === BUNDLED_SEED_PLAN_ID || seen.has(id)) continue;
        seen.add(id);
        let name;
        try {
          name = normalizePlanName(entry?.name || id);
        } catch {
          name = id;
        }
        plans.push({
          id,
          name,
          rowCount: Math.max(0, Math.trunc(Number(entry?.rowCount) || 0)),
          createdAt: String(entry?.createdAt || ""),
          updatedAt: String(entry?.updatedAt || "")
        });
      }
    }
    const activePlanId = String(raw?.activePlanId || BUNDLED_SEED_PLAN_ID).trim() || BUNDLED_SEED_PLAN_ID;
    return { activePlanId, plans };
  } catch {
    return { activePlanId: BUNDLED_SEED_PLAN_ID, plans: [] };
  }
}

function writePlanIndex(config, index) {
  writeJsonAtomic(resolve(config.repoRoot, INDEX_FILE), {
    activePlanId: index.activePlanId || BUNDLED_SEED_PLAN_ID,
    plans: index.plans || []
  }, 0o600);
}

function customPlanFilePath(config, planId) {
  if (!PLAN_ID_PATTERN.test(planId) || planId === BUNDLED_SEED_PLAN_ID) {
    throw new Error("Invalid seed plan id.");
  }
  return resolve(config.repoRoot, PLANS_DIR, `${planId}.json`);
}

function resolveListedActivePlanId(storedId, items) {
  if (storedId && items.some((item) => item.id === storedId)) return storedId;
  if (items.some((item) => item.id === BUNDLED_SEED_PLAN_ID)) return BUNDLED_SEED_PLAN_ID;
  return items[0]?.id || BUNDLED_SEED_PLAN_ID;
}

export function normalizePlanName(value) {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  if (!name) throw new Error("Seed plan name cannot be empty.");
  if (name.length > MAX_SEED_PLAN_NAME_LENGTH) {
    throw new Error(`Seed plan name must be ${MAX_SEED_PLAN_NAME_LENGTH} characters or fewer.`);
  }
  if (/[\u0000-\u001f]/.test(name)) throw new Error("Seed plan name contains invalid characters.");
  return name;
}

export function slugifyPlanName(value) {
  const slug = String(value || "")
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return slug || "plan";
}

function newPlanId(name, used) {
  const slug = slugifyPlanName(name);
  const base = !slug || slug === BUNDLED_SEED_PLAN_ID || slug === "addon" ? "plan" : slug;
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  return `plan-${Date.now().toString(36)}`;
}

function csvCellValue(row, column) {
  if (column === "template_id") return row.template_id ?? row.templateId ?? "";
  if (column === "display_name") return row.display_name ?? row.displayName ?? "";
  if (column === "kind") return row.kind ?? "";
  if (column === "stack_size") return row.stack_size ?? row.stackSize ?? 1;
  if (column === "price") return row.price ?? "";
  if (column === "category_mask") return row.category_mask ?? row.categoryMask ?? 0;
  if (column === "category_depth") return row.category_depth ?? row.categoryDepth ?? 1;
  if (column === "quality_level") return row.quality_level ?? row.qualityLevel ?? 0;
  if (column === "special_boost") return row.special_boost === true || row.specialBoost === true ? "true" : "false";
  if (column === "listings") return row.listings ?? 1;
  if (column === "durability_cur") return row.durability_cur ?? row.durabilityCur ?? "";
  if (column === "durability_max") return row.durability_max ?? row.durabilityMax ?? "";
  return "";
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function detectCsvDelimiter(source) {
  const firstLine = source.split(/\r?\n/, 1)[0] || "";
  const commas = (firstLine.match(/,/g) || []).length;
  const semis = (firstLine.match(/;/g) || []).length;
  return semis > commas ? ";" : ",";
}

function normalizeCsvHeader(value) {
  const key = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return CSV_HEADER_ALIASES[key] || key;
}

function rowToRecord(headers, values) {
  const record = {};
  for (let i = 0; i < headers.length; i += 1) {
    const header = headers[i];
    if (!header) continue;
    record[header] = values[i] ?? "";
  }
  return record;
}

function rowKey(templateId, qualityLevel) {
  return `${templateId}\0${qualityLevel}`;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return undefined;
}

function parseBoolean(value, fallback) {
  if (value === true || value === false) return value;
  const text = String(value || "").trim().toLowerCase();
  if (text === "true" || text === "1" || text === "yes") return true;
  if (text === "false" || text === "0" || text === "no") return false;
  return fallback;
}

function clampInt(value, fallback, min, max) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number)) return Math.min(Math.max(fallback, min), max);
  return Math.min(Math.max(number, min), max);
}
