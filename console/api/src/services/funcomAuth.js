import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export function saveFuncomTokenValue(config, token) {
  if (!token || String(token).length < 20) {
    const error = new Error("Token looks too short");
    error.statusCode = 400;
    throw error;
  }
  mkdirSync(config.secretsDir, { recursive: true });
  const path = resolve(config.secretsDir, "funcom-token.txt");
  writeFileSync(path, `${String(token).trim()}\n`, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch {}
}

export function validDockerSince(value) {
  const text = String(value || "").trim();
  if (/^\d+[smhdw]$/i.test(text)) return text;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/i.test(text)) return text;
  return "";
}

export function funcomAuthMismatchDetected(text) {
  return isFuncomAuthMismatchText(text);
}

export function matchingFuncomAuthLines(text) {
  return String(text || "").split(/\r?\n/)
    .filter((line) => isFuncomAuthMismatchText(line))
    .slice(-20)
    .join("\n");
}

function isFuncomAuthMismatchText(text) {
  const value = String(text || "");
  if (!value) return false;
  if (/Invalid Authorization to manage SelfHosted Battlegroup/i.test(value)) return true;
  if (/ACCESS_DENIED|AccessDenied|access denied|invalid authorization|Unauthorized/i.test(value)) {
    return /Battlegroup|SelfHosted|Funcom|FuncomLiveServices/i.test(value);
  }
  if (/(?:HTTP|status|statusCode|response|code)[^,\n]*(?:401|403)\b/i.test(value)) {
    return /Battlegroup|SelfHosted|Funcom|FuncomLiveServices/i.test(value);
  }
  return false;
}
