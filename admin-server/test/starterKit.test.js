import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { enableStarterKit, saveStarterKitConfig, starterKitCapabilities, starterKitConfig, validateStarterKitConfig } from "../src/starterKit.js";

test("starter kit is disabled by default and reports manual capability", () => {
  const config = tempConfig();
  try {
    assert.equal(starterKitConfig(config).enabled, false);
    const caps = starterKitCapabilities();
    assert.equal(caps.manualGrant, true);
    assert.equal(caps.automaticScanner, false);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

test("starter kit config validation rejects unsafe items and bounds", () => {
  assert.deepEqual(validateStarterKitConfig({
    enabled: false,
    version: "starter-kit-v1",
    items: [{ itemName: "Water", quantity: 2, durability: 1 }],
    xp: 100
  }).items[0], { itemName: "Water", itemId: "", quantity: 2, durability: 1 });
  assert.throws(() => validateStarterKitConfig({ version: "bad version with spaces" }), /Invalid Starter Kit version/);
  assert.throws(() => validateStarterKitConfig({ items: [{ itemName: "Bad\nName" }] }), /Invalid Starter Kit item name/);
  assert.throws(() => validateStarterKitConfig({ xp: -1 }), /xp/);
});

test("starter kit config writes and enable disable stay file-backed", () => {
  const config = tempConfig();
  try {
    const saved = saveStarterKitConfig(config, {
      enabled: false,
      version: "starter-kit-v2",
      items: [{ itemId: "WaterBottle_1", quantity: 1, durability: 1 }],
      xp: 10
    });
    assert.equal(saved.version, "starter-kit-v2");
    assert.equal(starterKitConfig(config).items[0].itemId, "WaterBottle_1");
    assert.equal(enableStarterKit(config, true).enabled, true);
    assert.equal(enableStarterKit(config, false).enabled, false);
  } finally {
    rmSync(config.repoRoot, { recursive: true, force: true });
  }
});

function tempConfig() {
  const repoRoot = mkdtempSync(join(tmpdir(), "starter-kit-test-"));
  return {
    repoRoot,
    generatedDir: resolve(repoRoot, "runtime/generated"),
    mockMode: true
  };
}
