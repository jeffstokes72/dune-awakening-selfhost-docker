import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";

export function updateEnvFileValue(repoRoot, key, value) {
  const envPath = resolve(repoRoot, ".env");
  const current = existsSync(envPath) ? readFileSync(envPath, "utf8").split(/\r?\n/) : [];
  const line = `${key}=${quoteEnv(String(value))}`;
  let found = false;
  const next = current.map((existing) => {
    if (existing.match(new RegExp(`^${key}=`))) {
      found = true;
      return line;
    }
    return existing;
  });
  if (!found) next.push(line);
  writeFileSync(envPath, `${next.filter((entry, index) => entry !== "" || index < next.length - 1).join("\n")}\n`, { mode: 0o644 });
  try { chmodSync(envPath, 0o644); } catch {}
}

export function quoteEnv(value) {
  if (/^[A-Za-z0-9_.:-]+$/.test(value)) return value;
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
