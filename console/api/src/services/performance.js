import { readFileSync, statfsSync } from "node:fs";

let previousCpuSample = null;

export async function performanceSnapshot(repoRoot) {
  const cpu = readCpuUsagePercent();
  const memory = readMemoryUsage();
  const disk = readDiskUsage(repoRoot);
  const uptimeSeconds = readHostUptimeSeconds();
  return {
    cpuPercent: cpu,
    memory,
    disk,
    uptimeSeconds,
    uptime: formatUptime(uptimeSeconds),
    sampledAt: new Date().toISOString()
  };
}

function readCpuUsagePercent() {
  const line = readFileSync("/proc/stat", "utf8").split(/\r?\n/).find((row) => row.startsWith("cpu "));
  if (!line) return null;
  const values = line.trim().split(/\s+/).slice(1).map((value) => Number(value) || 0);
  const idle = (values[3] || 0) + (values[4] || 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  const current = { idle, total };
  if (!previousCpuSample) {
    previousCpuSample = current;
    return null;
  }
  const totalDelta = current.total - previousCpuSample.total;
  const idleDelta = current.idle - previousCpuSample.idle;
  previousCpuSample = current;
  if (totalDelta <= 0) return null;
  return roundPercent(((totalDelta - idleDelta) / totalDelta) * 100);
}

function readMemoryUsage() {
  const rows = Object.fromEntries(readFileSync("/proc/meminfo", "utf8").split(/\r?\n/).map((line) => {
    const match = line.match(/^([^:]+):\s+(\d+)/);
    return match ? [match[1], Number(match[2]) * 1024] : null;
  }).filter(Boolean));
  const total = rows.MemTotal || 0;
  const available = rows.MemAvailable || 0;
  const used = Math.max(0, total - available);
  return {
    usedBytes: used,
    totalBytes: total,
    availableBytes: available,
    percent: total ? roundPercent((used / total) * 100) : null
  };
}

function readDiskUsage(path) {
  const stats = statfsSync(path || ".");
  const total = Number(stats.blocks) * Number(stats.bsize);
  const free = Number(stats.bavail) * Number(stats.bsize);
  const used = Math.max(0, total - free);
  return {
    usedBytes: used,
    totalBytes: total,
    freeBytes: free,
    percent: total ? roundPercent((used / total) * 100) : null
  };
}

function readHostUptimeSeconds() {
  const value = readFileSync("/proc/uptime", "utf8").trim().split(/\s+/)[0];
  return Math.max(0, Math.floor(Number(value) || 0));
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${days}d ${String(hours).padStart(2, "0")}h ${String(minutes).padStart(2, "0")}m`;
}

function roundPercent(value) {
  return Math.round(value * 10) / 10;
}
