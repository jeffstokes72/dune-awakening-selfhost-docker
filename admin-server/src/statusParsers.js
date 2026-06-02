export function parseHomeStatus(text) {
  return {
    population: findPopulation(text),
    database: summarizeDatabase(text),
    rabbitmq: summarizeRabbit(text),
    fls: summarizeFls(text)
  };
}

export function parseReadyRows(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^(OK|WAIT|FAIL)\s+/.test(line) && !/world_partition|partition/i.test(line)).map((line) => ({
    status: line.startsWith("OK") ? "Ready" : line.startsWith("WAIT") ? "Warn" : "Failed",
    label: line.replace(/^(OK|WAIT|FAIL)\s+/, "")
  }));
}

export function parsePortRows(text) {
  const seen = new Set();
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^(OK|WARN|FAIL|WAIT)\s+/.test(line) && /\b(udp|tcp)\b/i.test(line) && /\b\d{2,5}\b/.test(line) && !/advertises|advertised|local bind|private host|in-game ping/i.test(line)).map((line) => {
    const port = line.match(/\b(\d{2,5})(?:\/(udp|tcp))?\b/i)?.[1] || "";
    const protocol = (line.match(/\b\d{2,5}\/(udp|tcp)\b/i)?.[1] || line.match(/\b(udp|tcp)\b/i)?.[1] || "").toUpperCase();
    const name = line.replace(/^(OK|WARN|FAIL|WAIT)\s+/i, "").replace(/\blistening\b.*$/i, "").replace(/\b(on|port)\s+(UDP|TCP)?\s*\d{2,5}\b/i, "").trim();
    const key = `${name}-${port}-${protocol}`;
    if (!port || !protocol || seen.has(key)) return null;
    seen.add(key);
    return { name, port, protocol };
  }).filter(Boolean);
}

function findPopulation(text) {
  const line = text.split(/\r?\n/).find((candidate) => /population/i.test(candidate)) || "";
  return line.match(/\b(\d+\s*\/\s*\d+)\b/)?.[1]?.replace(/\s+/g, "") || "";
}

function summarizeDatabase(text) {
  const section = sectionLines(text, "Database").join("\n");
  const value = section.match(/World partitions:\s*(\d+)/i)?.[1] || "";
  return Number(value) > 0 ? "Ready" : "Warn";
}

function summarizeRabbit(text) {
  const lines = sectionLines(text, "RabbitMQ game connections");
  const director = numberAfterLabel(lines, "Director connections");
  const game = numberAfterLabel(lines, "Game server connections");
  return director >= 1 && game >= 1 ? "Ready" : "Warn";
}

function summarizeFls(text) {
  const lines = sectionLines(text, "Funcom/FLS summary");
  return lines.length && lines.every((line) => /:\s*OK$/i.test(line)) ? "Ready" : "Warn";
}

function sectionLines(text, section) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `=== ${section.toLowerCase()} ===`);
  if (start < 0) return [];
  const result = [];
  for (const line of lines.slice(start + 1)) {
    if (/^=== .+ ===$/.test(line.trim())) break;
    if (line.trim()) result.push(line.trim());
  }
  return result;
}

function numberAfterLabel(lines, label) {
  const line = lines.find((candidate) => candidate.toLowerCase().startsWith(label.toLowerCase())) || "";
  return Number(line.match(/(-?\d+)/)?.[1] || "0");
}
