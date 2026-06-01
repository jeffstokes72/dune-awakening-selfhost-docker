import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { buildDuneArgs, runDune } from "./runner.js";
import { resolveCatalogItem } from "./adminCatalog.js";

const DEFAULT_CONFIG = {
  enabled: false,
  version: "starter-kit-v1",
  items: [],
  xp: 0,
  allowRepeatGrants: false
};

export function starterKitCapabilities() {
  return {
    config: true,
    manualGrant: true,
    retryFailedGrant: true,
    automaticScanner: false,
    currency: false,
    reason: "Starter Kit manual grants use existing RedBlink dune admin grant-item/grant-item-id and award-xp commands. Automatic new-player scanning from arrakis-admin is not ported because this stack does not include its welcome-package ledger scanner runtime."
  };
}

export function starterKitConfig(config) {
  return readConfig(config);
}

export function saveStarterKitConfig(config, body) {
  const next = validateStarterKitConfig(body);
  writeConfig(config, next);
  return next;
}

export function enableStarterKit(config, enabled) {
  const next = { ...readConfig(config), enabled: Boolean(enabled) };
  writeConfig(config, next);
  return next;
}

export function starterKitHistory(config, limit = 100) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  const file = grantsPath(config);
  if (!existsSync(file)) return { rows: [] };
  const rows = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-safeLimit)
    .map((line) => JSON.parse(line))
    .reverse();
  return { rows };
}

export async function grantStarterKit(config, playerId, body = {}) {
  const phrase = "GRANT STARTER KIT";
  if (body.confirmation !== phrase) throw new Error(`Confirmation phrase required: ${phrase}`);
  const kit = readConfig(config);
  validatePlayerTarget(playerId);
  if (!kit.items.length && !kit.xp) throw new Error("Starter Kit has no configured items or XP");

  const grantId = randomUUID();
  const startedAt = new Date().toISOString();
  const results = [];
  for (const item of kit.items) {
    try {
      const resolved = resolveCatalogItem(config.repoRoot, item.itemId ? { itemId: item.itemId } : { itemName: item.itemName });
      const operation = item.itemId ? "adminGiveItemId" : "adminGiveItem";
      const payload = {
        playerId,
        itemId: resolved.itemId,
        itemName: resolved.name,
        quantity: item.quantity,
        durability: item.durability
      };
      const command = buildDuneArgs(operation, payload);
      const result = config.mockMode ? { code: 0, stdout: "mock starter item grant\n", stderr: "" } : await runDune(config, command);
      results.push({ ok: true, operation, item: payload, stdout: result.stdout, stderr: result.stderr, exitCode: result.code });
    } catch (error) {
      results.push({ ok: false, item, error: error.message || String(error) });
    }
  }
  if (kit.xp > 0) {
    try {
      const payload = { playerId, amount: kit.xp };
      const command = buildDuneArgs("adminAddXp", payload);
      const result = config.mockMode ? { code: 0, stdout: "mock starter xp grant\n", stderr: "" } : await runDune(config, command);
      results.push({ ok: true, operation: "adminAddXp", amount: kit.xp, stdout: result.stdout, stderr: result.stderr, exitCode: result.code });
    } catch (error) {
      results.push({ ok: false, operation: "adminAddXp", amount: kit.xp, error: error.message || String(error) });
    }
  }
  const ok = results.every((result) => result.ok);
  const row = { id: grantId, playerId, version: kit.version, ok, startedAt, finishedAt: new Date().toISOString(), results };
  appendGrant(config, row);
  return row;
}

export async function retryStarterKitGrant(config, grantId, body = {}) {
  const phrase = "RETRY STARTER KIT";
  if (body.confirmation !== phrase) throw new Error(`Confirmation phrase required: ${phrase}`);
  const existing = starterKitHistory(config, 500).rows.find((row) => row.id === grantId);
  if (!existing) throw new Error("Starter Kit grant was not found");
  if (existing.ok) throw new Error("Only failed Starter Kit grants can be retried");
  return grantStarterKit(config, existing.playerId, { confirmation: "GRANT STARTER KIT" });
}

export function validateStarterKitConfig(body = {}) {
  const enabled = Boolean(body.enabled);
  const version = validateVersion(body.version || DEFAULT_CONFIG.version);
  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (rawItems.length > 25) throw new Error("Starter Kit supports at most 25 item entries");
  const items = rawItems.map(validateStarterKitItem);
  const xp = validateInteger(body.xp ?? 0, "xp", 0, 100000000);
  return {
    enabled,
    version,
    items,
    xp,
    allowRepeatGrants: Boolean(body.allowRepeatGrants)
  };
}

function validateStarterKitItem(item = {}) {
  const itemName = String(item.itemName || "").trim();
  const itemId = String(item.itemId || "").trim();
  if (!itemName && !itemId) throw new Error("Starter Kit item requires itemName or itemId");
  if (itemName && (itemName.length > 240 || /[\r\n]/.test(itemName))) throw new Error("Invalid Starter Kit item name");
  if (itemId && !/^[A-Za-z0-9_./:-]{1,240}$/.test(itemId)) throw new Error("Invalid Starter Kit item id");
  return {
    itemName,
    itemId,
    quantity: validateInteger(item.quantity ?? 1, "quantity", 1, 1000000),
    durability: validateNumber(item.durability ?? 1, "durability", 0, 1)
  };
}

function validatePlayerTarget(value) {
  const raw = String(value || "").trim();
  if (/^[A-Za-z0-9_#./:-]{1,160}$/.test(raw)) return raw;
  throw new Error("Invalid player id");
}

function validateVersion(value) {
  const raw = String(value || "").trim();
  if (/^[A-Za-z0-9_.:-]{1,80}$/.test(raw)) return raw;
  throw new Error("Invalid Starter Kit version");
}

function validateInteger(value, name, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return number;
}

function validateNumber(value, name, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new Error(`${name} must be a number from ${min} to ${max}`);
  return number;
}

function configPath(config) {
  return resolve(config.generatedDir, "starter-kit.json");
}

function grantsPath(config) {
  return resolve(config.generatedDir, "starter-kit-grants.jsonl");
}

function readConfig(config) {
  const file = configPath(config);
  if (!existsSync(file)) return DEFAULT_CONFIG;
  return validateStarterKitConfig(JSON.parse(readFileSync(file, "utf8")));
}

function writeConfig(config, value) {
  const file = configPath(config);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch {}
}

function appendGrant(config, row) {
  const file = grantsPath(config);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch {}
}
