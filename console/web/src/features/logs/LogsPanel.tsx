import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { logsApi } from "../../api/logs";
import { mapsApi } from "../../api/maps";
import { LogViewer } from "../../components/LogViewer";
import { friendlyServiceName } from "../../lib/serviceDisplay";

type LogSietchRow = { partitionId: string; dimension: string; displayName: string };

export function LogsPanel({ selectedService, setSelectedService, text, setText, onError }: { selectedService: string; setSelectedService: (service: string) => void; text: string; setText: Dispatch<SetStateAction<string>>; onError: (text: string) => void }) {
  const [services, setServices] = useState<string[]>([]);
  const [sietchRows, setSietchRows] = useState<LogSietchRow[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState("");

  const loadSelectedLogs = useCallback(async (service = selectedService) => {
    onError("");
    try {
      setText((current) => current ? current : "Loading logs...");
      setText((await logsApi.get(service)).stdout);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }, [onError, selectedService, setText]);

  useEffect(() => {
    logsApi.services().then((result) => setServices(result.services)).catch(() => undefined);
    Promise.all([mapsApi.sietchDimensions("Survival_1"), mapsApi.sietchDimensions("Survival_1", true)])
      .then(([dimensions, ids]) => setSietchRows(parseLogSietchRows(dimensions.stdout || "", ids.stdout || "")))
      .catch(() => setSietchRows([]));
  }, []);

  useEffect(() => {
    let active = true;
    onError("");
    setText("Loading logs...");
    logsApi.get(selectedService).then((result) => {
      if (active) setText(result.stdout);
    }).catch((error) => {
      if (active) onError(error instanceof Error ? error.message : String(error));
    });
    return () => { active = false; };
  }, [selectedService, onError, setText]);

  useEffect(() => {
    if (!streaming) return;
    const source = new EventSource(logsApi.streamUrl(selectedService), { withCredentials: true });
    source.onmessage = (event) => {
      if (paused) return;
      const data = JSON.parse(event.data) as { line: string };
      setText((current) => `${current}${data.line}`);
    };
    source.onerror = () => source.close();
    return () => source.close();
  }, [streaming, paused, selectedService, setText]);

  const shown = filter ? text.split(/\r?\n/).filter((line) => line.toLowerCase().includes(filter.toLowerCase())).join("\n") : text;

  return (
    <section className="panel">
      <h2>Logs</h2>
      <div className="action-row logs-action-row">
        <select value={selectedService} onChange={(event) => setSelectedService(event.target.value)}>
          {services.map((service) => <option key={service} value={service}>{friendlyLogServiceName(service, sietchRows)}</option>)}
        </select>
        <button onClick={() => loadSelectedLogs()}>Refresh Logs</button>
        <button onClick={() => setStreaming(!streaming)}>{streaming ? "Stop Stream" : "Live Stream"}</button>
        <button onClick={() => setPaused(!paused)}>{paused ? "Resume" : "Pause"}</button>
        <a className="button-link" href={logsApi.downloadUrl(selectedService)}>Download</a>
        <button className="logs-clear-button" onClick={() => setText("")}>Clear</button>
      </div>
      <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Search Logs" />
      <LogViewer text={shown} />
    </section>
  );
}

function friendlyLogServiceName(name: string, sietches: LogSietchRow[] = []) {
  const partitionId = survivalLogPartitionId(name);
  if (!partitionId) return friendlyServiceName(name);
  const sietch = sietches.find((row) => row.partitionId === partitionId) || (partitionId === "1" ? sietches.find((row) => String(row.dimension) === "0") : undefined);
  const displayName = sietch?.displayName?.trim();
  return displayName ? `${partitionId === "1" ? "Survival_1" : `Survival_1 ${partitionId}`} (${displayName})` : friendlyServiceName(name);
}

function survivalLogPartitionId(name: string) {
  const raw = String(name || "").trim();
  if (/^(survival|survival-1|dune-server-survival-1)$/i.test(raw)) return "1";
  const match = raw.match(/^dune-server-survival-1-(\d+)$/i);
  return match?.[1] || "";
}

function parseLogSietchRows(text: string, idsText = ""): LogSietchRow[] {
  const idByDimension = new Map<string, string>();
  for (const rawLine of idsText.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(/^(\d+)\s*[|:]\s*(\d+)/);
    if (match) idByDimension.set(match[2], match[1]);
  }
  const rows: LogSietchRow[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^dimension\b/i.test(line)) continue;
    const parts = line.split("|").map((part) => part.trim());
    if (parts.length >= 2 && /^\d+$/.test(parts[0])) {
      rows.push({ dimension: parts[0], partitionId: idByDimension.get(parts[0]) || parts[0], displayName: parts[1] || `Sietch ${parts[0]}` });
    }
  }
  return rows;
}
