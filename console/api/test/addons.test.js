import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchCommunityAddons, installedAddonContentPath, listInstalledAddons, normalizeAddonManifest, normalizeCommunityAddonManifest, normalizeCommunityAddonsIndex, removeInstalledAddon, setInstalledAddonEnabled, validateZipEntries } from "../src/addons.js";

test("normalizes community addons index summaries", () => {
  const result = normalizeCommunityAddonsIndex({
    schemaVersion: 1,
    updatedAt: "2026-06-15T00:00:00Z",
    addons: [{
      id: "leadership-board-demo",
      name: "Leadership Board Demo",
      description: "Demo addon.",
      author: "Red-Blink",
      version: "1.0.0",
      manifestUrl: "https://raw.githubusercontent.com/Red-Blink/dune-docker-addons/main/addons/leadership-board-demo.json"
    }]
  }, "https://example.test/index.json");
  assert.equal(result.sourceUrl, "https://example.test/index.json");
  assert.equal(result.addons.length, 1);
  assert.equal(result.addons[0].id, "leadership-board-demo");
});

test("rejects unsafe or malformed community addon entries", () => {
  assert.throws(() => normalizeCommunityAddonsIndex({ schemaVersion: 1, addons: [{ id: "../bad", name: "Bad", version: "1", manifestUrl: "https://example.test/a.json" }] }), /invalid id/);
  assert.throws(() => normalizeCommunityAddonsIndex({ schemaVersion: 1, addons: [{ id: "good-addon", name: "Bad", version: "1", manifestUrl: "http://example.test/a.json" }] }), /HTTPS/);
  assert.throws(() => normalizeCommunityAddonsIndex({ schemaVersion: 2, addons: [] }), /Unsupported/);
});

test("fetches and validates community addons with injected fetch", async () => {
  const result = await fetchCommunityAddons(async (url) => ({
    ok: true,
    status: 200,
    async json() {
      if (String(url).endsWith("/demo.json")) {
        return {
          id: "demo-addon",
          name: "Demo",
          version: "1.0.0",
          type: "ui",
          sourceUrl: "https://github.com/Red-Blink/demo-addon",
          downloadUrl: "https://github.com/Red-Blink/demo-addon/releases/download/v1.0.0/demo.zip",
          sha256: "862cbb38adab95ffc7b584aa374d3a1fb4437cf33f0360e3a8f5120ab83e4bd4",
          permissions: []
        };
      }
      return {
        schemaVersion: 1,
        addons: [{ id: "demo-addon", name: "Demo", version: "1.0.0", manifestUrl: "https://example.test/demo.json" }]
      };
    },
    url
  }), "https://example.test/index.json");
  assert.equal(result.addons[0].name, "Demo");
  assert.equal(result.addons[0].sourceUrl, "https://github.com/Red-Blink/demo-addon");
});

test("validates community addon manifests for pinned install assets", () => {
  const manifest = normalizeCommunityAddonManifest({
    id: "leadership-board-demo",
    name: "Leadership Board Demo",
    version: "1.0.0",
    type: "ui",
    entry: { navigation: "Leadership Board Demo", path: "web/index.html" },
    sourceUrl: "https://github.com/Red-Blink/dune-docker-leadership",
    downloadUrl: "https://github.com/Red-Blink/dune-docker-leadership/releases/download/v1.0.0/leadership-board.zip",
    sha256: "862cbb38adab95ffc7b584aa374d3a1fb4437cf33f0360e3a8f5120ab83e4bd4",
    permissions: ["players:read"]
  });
  assert.equal(manifest.id, "leadership-board-demo");
  assert.equal(manifest.downloadUrl, "https://github.com/Red-Blink/dune-docker-leadership/releases/download/v1.0.0/leadership-board.zip");
  assert.equal(manifest.permissions[0], "players:read");
});

test("rejects unsafe addon manifests and zip entries", () => {
  assert.throws(() => normalizeAddonManifest({ id: "bad", name: "Bad", version: "1", type: "service", entry: { path: "web/index.html" } }), /Only ui/);
  assert.throws(() => normalizeAddonManifest({ id: "bad", name: "Bad", version: "1", type: "ui", entry: { path: "../index.html" } }), /unsafe/);
  assert.throws(() => normalizeCommunityAddonManifest({ id: "bad", name: "Bad", version: "1", type: "ui", entry: { path: "web/index.html" }, sourceUrl: "https://example.test", downloadUrl: "https://example.test/a.zip", sha256: "bad" }), /sha256/);
  assert.throws(() => validateZipEntries(["addon.json", "../evil"]), /unsafe/);
  assert.throws(() => validateZipEntries(["web/index.html"]), /addon.json/);
  assert.equal(validateZipEntries(["addon.json", "web/index.html", "web/addon.js"]), true);
});

test("tracks installed addon enable disable and removal state", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-addons-"));
  try {
    const addonDir = join(repoRoot, "runtime/addons/installed/leadership-board-demo");
    mkdirSync(addonDir, { recursive: true });
    writeFileSync(join(addonDir, "addon.json"), JSON.stringify({
      id: "leadership-board-demo",
      name: "Leadership Board Demo",
      version: "1.0.0",
      type: "ui",
      entry: { path: "web/index.html" },
      permissions: ["players:read"]
    }));
    const config = { repoRoot };
    assert.equal(listInstalledAddons(config).addons[0].status, "Disabled");
    assert.equal(setInstalledAddonEnabled(config, "leadership-board-demo", true).addon.status, "Enabled");
    assert.equal(listInstalledAddons(config).addons[0].enabled, true);
    assert.equal(installedAddonContentPath(config, "leadership-board-demo", "web/index.html"), join(addonDir, "web/index.html"));
    assert.throws(() => installedAddonContentPath(config, "leadership-board-demo", "../addon.json"), /unsafe/);
    assert.equal(setInstalledAddonEnabled(config, "leadership-board-demo", false).addon.status, "Disabled");
    assert.throws(() => installedAddonContentPath(config, "leadership-board-demo", "web/index.html"), /disabled/);
    assert.deepEqual(removeInstalledAddon(config, "leadership-board-demo"), { ok: true, id: "leadership-board-demo" });
    assert.deepEqual(listInstalledAddons(config).addons, []);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
