import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";

export const COMMUNITY_ADDONS_INDEX_URL = "https://raw.githubusercontent.com/Red-Blink/dune-docker-addons/main/index.json";

const MAX_COMMUNITY_ADDONS = 200;
const MAX_ADDON_ARCHIVE_BYTES = 50 * 1024 * 1024;
const ADDON_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

export async function fetchCommunityAddons(fetchImpl = globalThis.fetch, indexUrl = COMMUNITY_ADDONS_INDEX_URL) {
  if (typeof fetchImpl !== "function") throw new Error("Fetch is unavailable in this runtime.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetchImpl(indexUrl, {
      headers: { accept: "application/json" },
      signal: controller.signal
    });
    if (!response?.ok) throw new Error(`Community addons index returned HTTP ${response?.status || "unknown"}.`);
    const data = await response.json();
    const index = normalizeCommunityAddonsIndex(data, indexUrl);
    return await enrichCommunityAddonSourceUrls(index, fetchImpl, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function enrichCommunityAddonSourceUrls(index, fetchImpl, signal) {
  const addons = await Promise.all(index.addons.map(async (addon) => {
    if (addon.sourceUrl) return addon;
    try {
      const response = await fetchImpl(addon.manifestUrl, { headers: { accept: "application/json" }, signal });
      if (!response?.ok) return addon;
      const manifest = normalizeCommunityAddonManifest(await response.json());
      return manifest.id === addon.id ? { ...addon, sourceUrl: manifest.sourceUrl } : addon;
    } catch {
      return addon;
    }
  }));
  return { ...index, addons };
}

export function normalizeCommunityAddonsIndex(data, sourceUrl = COMMUNITY_ADDONS_INDEX_URL) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Community addons index must be a JSON object.");
  if (Number(data.schemaVersion) !== 1) throw new Error("Unsupported community addons index schema version.");
  if (!Array.isArray(data.addons)) throw new Error("Community addons index must include an addons array.");
  if (data.addons.length > MAX_COMMUNITY_ADDONS) throw new Error(`Community addons index cannot list more than ${MAX_COMMUNITY_ADDONS} addons.`);
  const seen = new Set();
  const addons = data.addons.map((addon, index) => normalizeCommunityAddonSummary(addon, index, seen));
  return {
    schemaVersion: 1,
    sourceUrl,
    updatedAt: stringField(data.updatedAt, "updatedAt", { optional: true }),
    addons
  };
}

export function listInstalledAddons(config) {
  const installedRoot = addonsInstalledRoot(config);
  const state = readAddonState(config);
  if (!existsSync(installedRoot)) return { addons: [] };
  const addons = readdirSync(installedRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && ADDON_ID_PATTERN.test(entry.name))
    .map((entry) => {
      try {
        const manifest = normalizeAddonManifest(JSON.parse(readFileSync(resolve(installedRoot, entry.name, "addon.json"), "utf8")));
        const enabled = Boolean(state[manifest.id]?.enabled);
        return {
          id: manifest.id,
          name: manifest.name,
          description: manifest.description,
          author: manifest.author,
          version: manifest.version,
          type: manifest.type,
          status: enabled ? "Enabled" : "Disabled",
          enabled,
          entryPath: manifest.entry.path,
          permissions: manifest.permissions
        };
      } catch {
        return {
          id: entry.name,
          name: entry.name,
          description: "",
          author: "",
          version: "",
          type: "",
          status: "Invalid",
          enabled: false,
          entryPath: "",
          permissions: []
        };
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  return { addons };
}

export async function installCommunityAddon(config, addonId, fetchImpl = globalThis.fetch) {
  const requestedId = stringField(addonId, "id");
  if (!ADDON_ID_PATTERN.test(requestedId)) throw new Error("Invalid addon id.");
  const index = await fetchCommunityAddons(fetchImpl);
  const summary = index.addons.find((addon) => addon.id === requestedId);
  if (!summary) throw new Error(`Community addon not found: ${requestedId}`);
  const manifestResponse = await fetchImpl(summary.manifestUrl, { headers: { accept: "application/json" } });
  if (!manifestResponse?.ok) throw new Error(`Addon manifest returned HTTP ${manifestResponse?.status || "unknown"}.`);
  const remoteManifest = normalizeCommunityAddonManifest(await manifestResponse.json());
  if (remoteManifest.id !== summary.id) throw new Error("Addon manifest id does not match the community index entry.");
  if (remoteManifest.version !== summary.version) throw new Error("Addon manifest version does not match the community index entry.");
  const archive = await downloadAddonArchive(fetchImpl, remoteManifest.downloadUrl);
  const actualSha = createHash("sha256").update(archive).digest("hex");
  if (actualSha.toLowerCase() !== remoteManifest.sha256.toLowerCase()) throw new Error("Addon archive SHA-256 does not match the community manifest.");

  const addonRoot = addonsRoot(config);
  const downloadsRoot = resolve(addonRoot, "downloads");
  const stagingRoot = resolve(addonRoot, "staging", `${remoteManifest.id}-${Date.now()}`);
  const installedRoot = addonsInstalledRoot(config);
  const archivePath = resolve(downloadsRoot, `${remoteManifest.id}-${remoteManifest.version}.zip`);
  mkdirSync(downloadsRoot, { recursive: true });
  mkdirSync(dirname(stagingRoot), { recursive: true });
  mkdirSync(installedRoot, { recursive: true });
  writeFileSync(archivePath, archive, { mode: 0o600 });

  const entries = (await runCommand("unzip", ["-Z1", archivePath])).stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  validateZipEntries(entries);
  rmSync(stagingRoot, { recursive: true, force: true });
  mkdirSync(stagingRoot, { recursive: true });
  await runCommand("unzip", ["-q", archivePath, "-d", stagingRoot]);

  const installedManifest = normalizeAddonManifest(JSON.parse(readFileSync(resolve(stagingRoot, "addon.json"), "utf8")));
  if (installedManifest.id !== remoteManifest.id) throw new Error("Installed addon package id does not match the community manifest.");
  if (installedManifest.version !== remoteManifest.version) throw new Error("Installed addon package version does not match the community manifest.");
  const entryPath = safeAddonRelativePath(installedManifest.entry.path, "entry.path");
  if (!existsSync(resolve(stagingRoot, entryPath))) throw new Error("Installed addon package entry path was not found.");

  const destination = resolve(installedRoot, installedManifest.id);
  rmSync(destination, { recursive: true, force: true });
  renameSync(stagingRoot, destination);
  setAddonEnabled(config, installedManifest.id, false);
  return {
    ok: true,
    addon: {
      id: installedManifest.id,
      name: installedManifest.name,
      description: installedManifest.description,
      author: installedManifest.author,
      version: installedManifest.version,
      type: installedManifest.type,
      status: "Disabled",
      enabled: false,
      entryPath: installedManifest.entry.path,
      permissions: installedManifest.permissions
    },
    sha256: actualSha
  };
}

export function setInstalledAddonEnabled(config, addonId, enabled) {
  const id = normalizeAddonId(addonId);
  const addonPath = resolve(addonsInstalledRoot(config), id, "addon.json");
  if (!existsSync(addonPath)) throw new Error(`Installed addon not found: ${id}`);
  const manifest = normalizeAddonManifest(JSON.parse(readFileSync(addonPath, "utf8")));
  setAddonEnabled(config, id, enabled);
  return {
    ok: true,
    addon: {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      author: manifest.author,
      version: manifest.version,
      type: manifest.type,
      status: enabled ? "Enabled" : "Disabled",
      enabled: Boolean(enabled),
      entryPath: manifest.entry.path,
      permissions: manifest.permissions
    }
  };
}

export function removeInstalledAddon(config, addonId) {
  const id = normalizeAddonId(addonId);
  const addonDir = resolve(addonsInstalledRoot(config), id);
  if (!existsSync(addonDir)) throw new Error(`Installed addon not found: ${id}`);
  rmSync(addonDir, { recursive: true, force: true });
  const state = readAddonState(config);
  delete state[id];
  writeAddonState(config, state);
  return { ok: true, id };
}

export function installedAddonContentPath(config, addonId, contentPath) {
  const id = normalizeAddonId(addonId);
  const state = readAddonState(config);
  if (!state[id]?.enabled) throw new Error(`Installed addon is disabled: ${id}`);
  const root = resolve(addonsInstalledRoot(config), id);
  const target = resolve(root, safeAddonRelativePath(contentPath, "content path"));
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || resolve(root, rel) !== target) throw new Error("Addon content path is unsafe.");
  return target;
}

export function normalizeCommunityAddonManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("Addon manifest must be a JSON object.");
  if (Number(manifest.schemaVersion ?? 1) !== 1) throw new Error("Unsupported addon manifest schema version.");
  const id = stringField(manifest.id, "id");
  if (!ADDON_ID_PATTERN.test(id)) throw new Error("Addon manifest id is invalid.");
  const type = stringField(manifest.type, "type");
  if (type !== "ui") throw new Error("Only ui addons are supported right now.");
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions.map((permission) => stringField(permission, "permission")) : [];
  return {
    schemaVersion: 1,
    id,
    name: stringField(manifest.name, "name"),
    description: stringField(manifest.description, "description", { optional: true }),
    author: stringField(manifest.author, "author", { optional: true }),
    version: stringField(manifest.version, "version"),
    type,
    sourceUrl: httpsUrl(manifest.sourceUrl, "sourceUrl"),
    downloadUrl: httpsUrl(manifest.downloadUrl, "downloadUrl"),
    sha256: sha256Field(manifest.sha256),
    permissions
  };
}

export function normalizeAddonManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("Addon manifest must be a JSON object.");
  if (Number(manifest.schemaVersion ?? 1) !== 1) throw new Error("Unsupported addon manifest schema version.");
  const id = stringField(manifest.id, "id");
  if (!ADDON_ID_PATTERN.test(id)) throw new Error("Addon manifest id is invalid.");
  const type = stringField(manifest.type, "type");
  if (type !== "ui") throw new Error("Only ui addons are supported right now.");
  const entry = manifest.entry && typeof manifest.entry === "object" && !Array.isArray(manifest.entry) ? manifest.entry : {};
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions.map((permission) => stringField(permission, "permission")) : [];
  return {
    schemaVersion: 1,
    id,
    name: stringField(manifest.name, "name"),
    description: stringField(manifest.description, "description", { optional: true }),
    author: stringField(manifest.author, "author", { optional: true }),
    version: stringField(manifest.version, "version"),
    type,
    entry: {
      navigation: stringField(entry.navigation, "entry.navigation", { optional: true }),
      path: safeAddonRelativePath(entry.path, "entry.path")
    },
    permissions
  };
}

export function validateZipEntries(entries) {
  if (!entries.includes("addon.json")) throw new Error("Addon archive must contain addon.json at the root.");
  for (const entry of entries) {
    safeAddonRelativePath(entry, "zip entry");
  }
  return true;
}

function normalizeCommunityAddonSummary(addon, index, seen) {
  if (!addon || typeof addon !== "object" || Array.isArray(addon)) throw new Error(`Addon entry ${index + 1} must be an object.`);
  const id = stringField(addon.id, "id");
  if (!ADDON_ID_PATTERN.test(id)) throw new Error(`Addon entry ${index + 1} has an invalid id.`);
  if (seen.has(id)) throw new Error(`Duplicate addon id: ${id}`);
  seen.add(id);
  return {
    id,
    name: stringField(addon.name, "name"),
    description: stringField(addon.description, "description", { optional: true }),
    author: stringField(addon.author, "author", { optional: true }),
    version: stringField(addon.version, "version"),
    sourceUrl: addon.sourceUrl ? httpsUrl(addon.sourceUrl, "sourceUrl") : "",
    manifestUrl: httpsUrl(addon.manifestUrl, "manifestUrl")
  };
}

function stringField(value, name, { optional = false } = {}) {
  const text = String(value ?? "").trim();
  if (!text && optional) return "";
  if (!text) throw new Error(`Addon ${name} is required.`);
  if (text.length > 500) throw new Error(`Addon ${name} is too long.`);
  return text;
}

function httpsUrl(value, name) {
  const text = stringField(value, name);
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`Addon ${name} must be a valid URL.`);
  }
  if (parsed.protocol !== "https:") throw new Error(`Addon ${name} must use HTTPS.`);
  return parsed.toString();
}

function sha256Field(value) {
  const text = stringField(value, "sha256").toLowerCase();
  if (!SHA256_PATTERN.test(text)) throw new Error("Addon sha256 must be a 64-character hex string.");
  return text;
}

function normalizeAddonId(value) {
  const id = stringField(value, "id");
  if (!ADDON_ID_PATTERN.test(id)) throw new Error("Invalid addon id.");
  return id;
}

function safeAddonRelativePath(value, name) {
  const text = stringField(value, name);
  const normalized = text.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.includes("\0")) throw new Error(`Addon ${name} is unsafe.`);
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) throw new Error(`Addon ${name} is unsafe.`);
  if (parts.some((part) => part !== basename(part))) throw new Error(`Addon ${name} is unsafe.`);
  if (normalized.length > 500) throw new Error(`Addon ${name} is too long.`);
  return parts.join("/");
}

async function downloadAddonArchive(fetchImpl, url) {
  const response = await fetchImpl(url, { headers: { accept: "application/zip, application/octet-stream" } });
  if (!response?.ok) throw new Error(`Addon archive returned HTTP ${response?.status || "unknown"}.`);
  const contentLength = Number(response.headers?.get?.("content-length") || 0);
  if (contentLength > MAX_ADDON_ARCHIVE_BYTES) throw new Error("Addon archive is too large.");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error("Addon archive is empty.");
  if (buffer.length > MAX_ADDON_ARCHIVE_BYTES) throw new Error("Addon archive is too large.");
  return buffer;
}

function addonsRoot(config) {
  return resolve(config.repoRoot, "runtime", "addons");
}

function addonsInstalledRoot(config) {
  return resolve(addonsRoot(config), "installed");
}

function addonStatePath(config) {
  return resolve(addonsRoot(config), "state.json");
}

function readAddonState(config) {
  try {
    const state = JSON.parse(readFileSync(addonStatePath(config), "utf8"));
    return state && typeof state === "object" && !Array.isArray(state) ? state : {};
  } catch {
    return {};
  }
}

function writeAddonState(config, state) {
  const file = addonStatePath(config);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function setAddonEnabled(config, addonId, enabled) {
  const state = readAddonState(config);
  state[addonId] = { ...(state[addonId] || {}), enabled: Boolean(enabled) };
  writeAddonState(config, state);
}

function runCommand(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(stderr || stdout || `${command} failed with exit ${code}`));
    });
  });
}
