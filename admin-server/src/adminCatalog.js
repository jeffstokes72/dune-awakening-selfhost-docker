import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function resolveCatalogItem(repoRoot, { itemName = "", itemId = "" } = {}) {
  const value = String(itemId || itemName || "").trim();
  if (!value || value.length > 240 || /[\r\n]/.test(value)) throw new Error("Item name or id is required");

  const items = JSON.parse(readFileSync(resolve(repoRoot, "runtime/data/admin-items.json"), "utf8"));
  const mode = itemId ? "id" : "name";
  if (mode === "id") {
    const exact = items.find((item) => String(item.id || "") === value);
    return normalizeItem(exact || { id: value, name: value, category: "manual", source: "manual" });
  }

  const folded = value.toLowerCase();
  const exactNames = items.filter((item) => String(item.name || "").toLowerCase() === folded);
  if (exactNames.length === 1) return normalizeItem(exactNames[0]);
  if (exactNames.length > 1) {
    const nonSchematics = exactNames.filter((item) => String(item.category || "").toLowerCase() !== "schematics");
    if (nonSchematics.length === 1) return normalizeItem(nonSchematics[0]);
    throw new Error(`Ambiguous item name: ${value}`);
  }

  const exactId = items.find((item) => String(item.id || "") === value);
  if (exactId) return normalizeItem(exactId);
  throw new Error(`No item found for: ${value}`);
}

export function listCatalogItems(repoRoot, { q = "", limit = 500 } = {}) {
  const items = JSON.parse(readFileSync(resolve(repoRoot, "runtime/data/admin-items.json"), "utf8"));
  const term = String(q || "").trim().toLowerCase();
  const max = Math.max(1, Math.min(Number(limit) || 500, 2000));
  return items
    .filter((item) => {
      if (!term) return true;
      return String(item.id || "").toLowerCase().includes(term) ||
        String(item.name || "").toLowerCase().includes(term) ||
        String(item.category || "").toLowerCase().includes(term);
    })
    .slice(0, max)
    .map(normalizeItem);
}

function normalizeItem(item) {
  const id = String(item.id || "").trim();
  if (!/^[A-Za-z0-9_./:-]{1,240}$/.test(id)) throw new Error("Invalid resolved item id");
  return {
    id,
    itemId: id,
    name: String(item.name || id),
    category: String(item.category || "manual"),
    source: String(item.source || "manual")
  };
}
