import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { readJsonBody, safeStaticTarget } from "../src/httpSafety.js";

test("readJsonBody enforces request size limits", async () => {
  assert.deepEqual(await readJsonBody(Readable.from(["{\"ok\":true}"]), 100), { ok: true });
  await assert.rejects(() => readJsonBody(Readable.from(["{\"too\":\"large\"}"]), 5), /exceeds 5 bytes/);
});

test("safeStaticTarget prevents serving files outside static directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "arrakis-static-"));
  try {
    writeFileSync(resolve(dir, "index.html"), "index");
    writeFileSync(resolve(dir, "app.js"), "app");
    assert.equal(safeStaticTarget(dir, "/app.js"), resolve(dir, "app.js"));
    assert.equal(safeStaticTarget(dir, "/../../README.md"), resolve(dir, "index.html"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
