import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { adminApi } from "../../api/admin";
import { playersApi } from "../../api/players";
import { serverApi } from "../../api/server";
import { setupApi, type Task } from "../../api/setup";
import { DataTable } from "../../components/common/DataTable";
import { KeyValueGrid, TechnicalDetails } from "../../components/common/DisplayPrimitives";
import { InlineActionResult } from "../../components/common/InlineActionResult";
import { adminTaskFailureDetail, friendlyInlineError, titleCaseWords } from "../players/playerAdminUtils";
import { formatUiSentence, stripAnsi, titleCase } from "../../lib/display";

type HomeTaskResult = { status: "running" | "succeeded" | "failed" | "stopped"; title: string; message?: string; details?: string };
type ConfirmAction = (message: string, options?: { title?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean }) => Promise<boolean>;
type InlineResult = { key: string; tone: "success" | "danger" | "neutral"; text: string; pending?: boolean };

type AdminToolsPanelProps = {
  onError: (text: string) => void;
  confirmAction: ConfirmAction;
};

export function AdminToolsPanel({ onError, confirmAction }: AdminToolsPanelProps) {
  const [players, setPlayers] = useState<Record<string, unknown>[]>([]);
  const [scheduleOpen, setScheduleOpen] = useState(true);
  const [restartSchedule, setRestartSchedule] = useState<{ stdout?: string; stderr?: string; exitCode?: number } | null>(null);
  const [scheduleLoading, setScheduleLoading] = useState(true);
  const [restartEnabled, setRestartEnabled] = useState(false);
  const [restartTime, setRestartTime] = useState("05:00");
  const [restartNotifyMinutes, setRestartNotifyMinutes] = useState("15");
  const [scheduleResult, setScheduleResult] = useState<HomeTaskResult | null>(null);
  const [liveToolsOpen, setLiveToolsOpen] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [broadcastTitle, setBroadcastTitle] = useState("");
  const [broadcastBody, setBroadcastBody] = useState("");
  const [broadcastDuration, setBroadcastDuration] = useState("30");
  const [history, setHistory] = useState("");
  const [actionResult, setActionResult] = useState<InlineResult | null>(null);
  const resultTimer = useRef<number | null>(null);
  const scheduleSaving = scheduleResult?.status === "running";
  const restartScheduleValues = parseKeyValueText(restartSchedule?.stdout || "");
  const scheduleTimerValue = restartScheduleValues.systemd_timer || "";
  const scheduleTimerLabel = scheduleTimerValue ? formatTimerStatus(scheduleTimerValue) : "Not Installed";
  const scheduleTimerActive = /^active$/i.test(scheduleTimerValue);
  const scheduleActive = restartEnabled && scheduleTimerActive;
  const scheduleLoaded = Boolean(restartSchedule);
  const scheduleDisplayActive = scheduleSaving ? restartEnabled : scheduleActive;
  const scheduleStatusLabel = !scheduleLoaded && !scheduleSaving ? "Checking" : scheduleDisplayActive ? "Enabled" : "Disabled";
  const scheduleDisplayTimerLabel = !scheduleLoaded && !scheduleSaving ? "Checking" : scheduleSaving ? restartEnabled ? "Activating" : "Deactivating" : restartEnabled ? scheduleTimerLabel : "Inactive";

  async function run(action: () => Promise<unknown>) {
    onError("");
    try { await action(); } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  }

  function showActionResult(key: string, text: string, tone: InlineResult["tone"] = "success", pending = false) {
    setActionResult({ key, text, tone, pending });
    if (resultTimer.current) window.clearTimeout(resultTimer.current);
    resultTimer.current = null;
    if (!pending) resultTimer.current = window.setTimeout(() => setActionResult(null), 5000);
  }

  async function runAdminAction(key: string, pendingText: string, action: () => Promise<unknown>, successText: string, successTone: "success" | "danger" = "success", failureText?: string | ((error: unknown) => string)) {
    showActionResult(key, pendingText, "neutral", true);
    try {
      await action();
      showActionResult(key, successText, successTone);
    } catch (error) {
      showActionResult(key, typeof failureText === "function" ? failureText(error) : failureText || friendlyInlineError(error), "danger");
    }
  }

  async function loadHistory(open = false) {
    setHistory((await adminApi.history()).stdout || "");
    if (open) setHistoryOpen(true);
  }

  async function clearHistory() {
    if (!(await confirmAction("Clear command history?"))) return;
    await adminApi.clearHistory("admin-tools");
    setHistory("");
    setHistoryOpen(false);
  }

  async function runInlineTask(taskFactory: () => Promise<{ task: Task }>) {
    const response = await taskFactory();
    const final = await waitForTaskSilently(response.task);
    if (final.status !== "succeeded") {
      await loadHistory(true).catch(() => undefined);
      throw new Error(adminTaskFailureDetail(final) || final.errorMessage || final.progressMessage || "Admin action failed.");
    }
    await loadHistory(true);
    return final;
  }

  async function loadRestartSchedule() {
    setScheduleLoading(true);
    try {
      const result = await serverApi.restartSchedule();
      setRestartSchedule(result);
      const values = parseKeyValueText(result.stdout || "");
      const timerActive = /^active$/i.test(values.systemd_timer || "");
      setRestartEnabled(/^true$/i.test(values.scheduled_restart_enabled || "") && timerActive);
      if (values.restart_time && values.restart_time !== "unset") setRestartTime(toHourMinuteTime(values.restart_time));
      const notifyMatch = String(values.notify_players_before || "").match(/\d+/);
      if (notifyMatch) setRestartNotifyMinutes(notifyMatch[0]);
    } finally {
      setScheduleLoading(false);
    }
  }

  async function saveSchedule(nextEnabled = restartEnabled) {
    const sanitizedTime = toHourMinuteTime(restartTime);
    const notifyMinutes = Number(restartNotifyMinutes);
    if (nextEnabled && !isValidHourMinuteTime(sanitizedTime)) {
      setScheduleResult({ status: "failed", title: "Schedule Save Failed", message: "Restart time must be a valid 24-hour time, for example 05:00 or 23:30." });
      return;
    }
    if (nextEnabled && (!Number.isInteger(notifyMinutes) || notifyMinutes < 1 || notifyMinutes > 1440)) {
      setScheduleResult({ status: "failed", title: "Schedule Save Failed", message: "Notification time must be between 1 and 1440 minutes." });
      return;
    }
    setRestartTime(sanitizedTime);
    setRestartNotifyMinutes(String(Number.isInteger(notifyMinutes) ? notifyMinutes : 15));
    setScheduleResult({ status: "running", title: "Saving Schedule" });
    const requestedEnabled = nextEnabled;
    setRestartEnabled(requestedEnabled);
    onError("");
    try {
      const final = await waitForTaskSilently((await serverApi.saveRestartSchedule({ enabled: requestedEnabled, time: sanitizedTime, notifyMinutes })).task);
      const details = taskTechnicalDetails(final);
      const nextSchedule = await serverApi.restartSchedule();
      setRestartSchedule(nextSchedule);
      const nextValues = parseKeyValueText(nextSchedule.stdout || "");
      const timerActive = /^active$/i.test(nextValues.systemd_timer || "");
      const timerInactive = /^inactive$/i.test(nextValues.systemd_timer || "");
      if (requestedEnabled && !timerActive) setRestartEnabled(false);
      if (!requestedEnabled && timerInactive) setRestartEnabled(false);
      const notifyMatch = String(nextValues.notify_players_before || "").match(/\d+/);
      if (notifyMatch) setRestartNotifyMinutes(notifyMatch[0]);
      setScheduleResult(final.status === "succeeded" && (!requestedEnabled ? timerInactive : timerActive)
        ? { status: "succeeded", title: "Schedule Saved Successfully", details }
        : { status: "failed", title: requestedEnabled ? "Timer Install Failed" : "Schedule Save Failed", details: details || nextSchedule.stdout || nextSchedule.stderr || "" });
    } catch (error) {
      setRestartEnabled(!requestedEnabled);
      setScheduleResult({ status: "failed", title: "Schedule Save Failed", details: error instanceof Error ? error.message : String(error) });
    }
  }

  useEffect(() => {
    playersApi.list().then((result) => setPlayers(result.rows || [])).catch(() => undefined);
    loadHistory().catch(() => undefined);
    loadRestartSchedule().catch((error) => onError(error instanceof Error ? error.message : String(error)));
    return () => {
      if (resultTimer.current) window.clearTimeout(resultTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!scheduleResult || scheduleResult.status === "running") return;
    const id = window.setTimeout(() => setScheduleResult(null), 10400);
    return () => window.clearTimeout(id);
  }, [scheduleResult?.status, scheduleResult?.title]);

  async function hydrateOnlinePlayers() {
    const response = await playersApi.online();
    const targets = (response.rows || []).map((player) => String(player.action_player_id || player.funcom_id || player.fls_id || "")).filter(Boolean);
    if (!targets.length) {
      showActionResult("global", "No players are currently online.", "neutral");
      return;
    }
    if (!(await confirmAction(`Hydrate all ${targets.length} online player${targets.length === 1 ? "" : "s"}?`))) return;
    await runAdminAction("global", `Hydrating ${targets.length} online player${targets.length === 1 ? "" : "s"}`, async () => {
      const results = await Promise.allSettled(targets.map((target) => playersApi.giveItems(target, [{ itemId: "WaterPack_Consumable", quantity: 10, durability: 1 }], { historyScope: "admin-tools", historyFriendly: "Hydrate All" })));
      const failed = results.filter((result) => result.status === "rejected" || (result.status === "fulfilled" && result.value.ok === false)).length;
      await loadHistory(true);
      if (failed) throw new Error(`Hydration completed with ${failed} failed player${failed === 1 ? "" : "s"}.`);
    }, `Hydrated ${targets.length} online player${targets.length === 1 ? "" : "s"} successfully.`);
  }

  async function kickAllPlayers() {
    const response = await playersApi.online();
    const onlineCount = (response.rows || []).filter((player) => String(player.action_player_id || player.funcom_id || player.fls_id || "")).length;
    if (!onlineCount) {
      showActionResult("global", "No players are currently online.", "neutral");
      return;
    }
    if (!(await confirmAction(`Kick ${onlineCount} online player${onlineCount === 1 ? "" : "s"}?`))) return;
    await runAdminAction("global", `Kicking ${onlineCount} online player${onlineCount === 1 ? "" : "s"}`, () => runInlineTask(() => adminApi.kickAllOnline("KICK ALL ONLINE PLAYERS")), "All online players were kicked.", "danger");
  }

  async function sendBroadcast() {
    await runAdminAction("broadcast", "Sending broadcast message", async () => {
      await adminApi.broadcast(broadcastTitle, broadcastBody, Number(broadcastDuration || 30));
      await loadHistory(true);
    }, "Broadcast message was sent successfully.");
  }

  const historyRows = parseHistoryRows(history, players, "admin-tools");

  return <section className="panel admin-tools-panel">
    <h2>Admin Tools</h2>
    <div className={`playerAdmin_toggle ${scheduleOpen ? "open" : ""}`}>
      <button className="playerAdmin_toggleHeader" aria-label={scheduleOpen ? "Collapse Schedule Server Restart" : "Expand Schedule Server Restart"} onClick={() => setScheduleOpen(!scheduleOpen)}>{scheduleOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}<span>Schedule Server Restart</span></button>
      {scheduleOpen && <div className="playerAdmin_toggleBody">
        <div className="panel-title schedule-panel-title">
          <h4>Schedule Server Restart</h4>
          <label className={`switch-checkbox ${restartEnabled ? "enabled" : "disabled"}`}><input type="checkbox" disabled={scheduleLoading || scheduleSaving} checked={restartEnabled} onChange={(event) => run(() => saveSchedule(event.target.checked))} /><span className="switch-label">Daily Restart</span><strong className="switch-state">{restartEnabled ? "ON" : "OFF"}</strong></label>
        </div>
        <KeyValueGrid items={[["Current Status", scheduleStatusLabel], ["Restart Time (Local Server Time)", toHourMinuteTime(restartScheduleValues.restart_time || restartTime)], ["In-Game Notice Before", `${restartNotifyMinutes} minutes`], ["Timer", scheduleDisplayTimerLabel]]} />
        {commandStatusSummary(restartSchedule).reason && <p className="danger-note">{commandStatusSummary(restartSchedule).reason}</p>}
        <div className="action-line schedule-action-line">
          <label className="compact-select">Daily Restart Time<input type="time" step="60" pattern="[0-2][0-9]:[0-5][0-9]" disabled={scheduleSaving} value={restartTime} onChange={(event) => setRestartTime(sanitizeTimeInput(event.target.value))} placeholder="05:00" /></label>
          <label className="compact-select schedule-notify-field">In-Game Notice Before (Min)<input type="number" min="1" max="1440" step="1" disabled={scheduleSaving} value={restartNotifyMinutes} onChange={(event) => setRestartNotifyMinutes(event.target.value)} /></label>
          <button disabled={scheduleSaving || scheduleLoading} onClick={() => saveSchedule()}>Save Schedule</button>
          {scheduleResult && <span className={`inline-task-result result-${scheduleResult.status === "succeeded" ? "ok" : scheduleResult.status === "failed" ? "fail" : "running"}`}>
            <strong className={scheduleResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(scheduleResult.title, scheduleResult.status === "running")}</strong>
          </span>}
        </div>
      </div>}
    </div>
    <div className={`playerAdmin_toggle ${liveToolsOpen ? "open" : ""}`}>
      <button className="playerAdmin_toggleHeader" aria-label={liveToolsOpen ? "Collapse Global Live Tools" : "Expand Global Live Tools"} onClick={() => setLiveToolsOpen(!liveToolsOpen)}>{liveToolsOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}<span>Global Live Tools</span></button>
      {liveToolsOpen && <div className="playerAdmin_toggleBody"><div className="global-live-tools">
        <div className="action-line admin-global-actions">
          <button className="danger" onClick={() => run(kickAllPlayers)}>Kick All</button>
          <button className="success" onClick={() => run(hydrateOnlinePlayers)}>Hydrate All</button>
          <InlineActionResult result={actionResult} resultKey="global" />
        </div>
        <div className="action-line broadcast-line">
          <label className="broadcast-title">Broadcast Title<input value={broadcastTitle} onChange={(event) => setBroadcastTitle(event.target.value)} placeholder="Title shown in-game" /></label>
          <label className="broadcast-message">Broadcast Body<textarea rows={3} value={broadcastBody} onChange={(event) => setBroadcastBody(event.target.value)} placeholder="Message shown to online players" /></label>
          <div className="broadcast-controls-row">
            <label className="inline-field">Duration Seconds<input type="number" min="1" max="3600" value={broadcastDuration} onChange={(event) => setBroadcastDuration(event.target.value)} /></label>
            <button onClick={() => run(sendBroadcast)}>Send Broadcast</button>
            <InlineActionResult result={actionResult} resultKey="broadcast" />
          </div>
        </div>
      </div></div>}
    </div>
    <div className={`playerAdmin_toggle admin-history-toggle-panel ${historyOpen ? "open" : ""}`}>
      <button className="playerAdmin_toggleHeader" aria-label={historyOpen ? "Collapse Command History" : "Expand Command History"} onClick={() => setHistoryOpen(!historyOpen)}>{historyOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}<span>Command History</span></button>
      {historyOpen && <div className="playerAdmin_toggleBody"><div className="admin-history-content">
        {historyRows.length > 0 && <div className="action-row admin-history-actions"><button onClick={() => run(clearHistory)}>Clear</button></div>}
        {historyRows.length ? <div className="admin-history-table"><DataTable rows={historyRows} columns={["time", "action", "target", "status", "summary"]} tableClassName="admin-history-grid" /></div> : <div className="admin-history-empty">Command history will appear here after an admin action runs.</div>}
        {history && <TechnicalDetails title="Advanced history output" text={history} />}
      </div></div>}
    </div>
  </section>;
}

function formatResultTitle(value: unknown, pending = false) {
  return formatUiSentence(value, pending);
}

function parseKeyValueText(text: string) {
  const out: Record<string, string> = {};
  for (const rawLine of stripAnsi(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(/^([^:=]{2,80}):\s*(.*)$/);
    if (!match) continue;
    out[match[1].trim().toLowerCase().replace(/\s+/g, "_")] = match[2].trim();
  }
  return out;
}

function commandStatusSummary(result: { stdout?: string; stderr?: string; exitCode?: number } | null) {
  if (!result) return { status: "Loading", reason: "" };
  if (Number(result.exitCode || 0) === 0) return { status: "Checked", reason: "" };
  return { status: "Check Failed", reason: result.stderr || result.stdout || "Command failed" };
}

function formatTimerStatus(value: string) {
  const text = String(value || "").trim();
  if (/^not installed$/i.test(text)) return "Not Installed";
  return titleCase(text);
}

function toHourMinuteTime(value: unknown) {
  const text = String(value || "").trim();
  if (!text || /^unset$/i.test(text)) return "Unset";
  const match = text.match(/^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/);
  return match ? `${match[1]}:${match[2]}` : text;
}

function sanitizeTimeInput(value: string) {
  return value.replace(/[^\d:]/g, "").slice(0, 5);
}

function isValidHourMinuteTime(value: string) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function taskTechnicalDetails(task: Task) {
  return task.logLines.map((line) => line.line).filter(Boolean).join("\n") || task.errorMessage || "";
}

async function waitForTaskSilently(task: Task) {
  let current = task;
  for (let i = 0; i < 180 && !isTerminalTask(current.status); i += 1) {
    await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 1000));
    current = (await setupApi.task(current.id)).task;
  }
  return current;
}

function isTerminalTask(status: string) {
  return ["succeeded", "failed", "cancelled"].includes(status);
}

function parseHistoryRows(text: string, players: Record<string, unknown>[] = [], scope: "all" | "admin-tools" = "all") {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).filter((line) => !/^time\s+/i.test(line) && !/^no admin command history found\.?$/i.test(line)).map((line) => {
    const parts = line.split(/\t/);
    if (parts.length >= 6) {
      if (!adminHistoryLineMatchesScope(parts[1], parts[2], scope)) return null;
      return { time: formatAdminHistoryTime(parts[0]), action: friendlyAdminHistoryAction(parts[1]), target: friendlyAdminHistoryTarget(parts[2], players), status: friendlyAdminHistoryValue(parts[5]), summary: friendlyAdminHistorySummary(parts[3], parts[4], parts.slice(6).join(" "), parts[1]) };
    }
    const loose = line.split(/\s{2,}/).filter(Boolean);
    if (!adminHistoryLineMatchesScope(loose[1] || "", loose[2] || "", scope)) return null;
    return { time: formatAdminHistoryTime(loose[0] || ""), action: friendlyAdminHistoryAction(loose[1] || ""), target: friendlyAdminHistoryTarget(loose[2] || "", players), status: friendlyAdminHistoryValue(loose[5] || ""), summary: friendlyAdminHistorySummary(loose[3] || "", loose[4] || "", loose.slice(6).join(" "), loose[1] || "") };
  }).filter((row): row is { time: string; action: string; target: string; status: string; summary: string } => Boolean(row && (row.action || row.summary))).reverse();
}

function adminHistoryLineMatchesScope(command: string, target: string, scope: "all" | "admin-tools") {
  if (scope === "all") return true;
  const rawCommand = String(command || "").trim();
  const rawTarget = String(target || "").trim();
  if (/^web-(broadcast|shutdown-broadcast|hydrate-all)$/i.test(rawCommand)) return true;
  if (/^KickPlayer$/i.test(rawCommand) && /^(all|\*)$/i.test(rawTarget)) return true;
  return false;
}

function formatAdminHistoryTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function friendlyAdminHistoryValue(value: string) {
  const text = String(value || "-").replace(/^web[-_]/i, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text || text === "-") return "-";
  return titleCaseWords(text);
}

function friendlyAdminHistoryAction(value: string) {
  const raw = String(value || "").trim();
  const labels: Record<string, string> = { "web-hydrate-all": "Hydrate All", AddItemToInventory: "Grant Item", AwardXP: "Award XP", UpdateAllWaterFillables: "Refill Container", KickPlayer: "Kick Player", GrantTemplate: "Grant Template", SkillsSetUnspentSkillPoints: "Set Skill Points", SkillsSetModuleLevel: "Set Skill Module", CleanPlayerInventory: "Clean Inventory", ResetProgression: "Reset Progression", TeleportTo: "Teleport Player", SpawnVehicleAt: "Spawn Vehicle", SpecializationXP: "Specialization XP" };
  if (labels[raw]) return labels[raw];
  const cleaned = raw.replace(/^web[-_]/i, "").replace(/[-_]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/\bXP\b/i, "XP").replace(/\s+/g, " ").trim();
  return cleaned ? titleCaseWords(cleaned).replace(/\bXp\b/g, "XP") : "-";
}

function friendlyAdminHistoryTarget(value: string, players: Record<string, unknown>[]) {
  const text = String(value || "-").trim();
  if (!text || text === "-") return "-";
  if (/^(all|\*)$/i.test(text)) return "All";
  const row = players.find((player) => adminHistoryTargetCandidates(player).some((candidate) => matchesAdminHistoryTarget(candidate, text)));
  return row ? String(row.character_name || text) : friendlyAdminHistoryValue(text);
}

function adminHistoryTargetCandidates(player: Record<string, unknown>) {
  return [player.action_player_id, player.funcom_id, player.fls_id, player.account_id, player.actor_id, player.player_pawn_id, player.id].map((candidate) => String(candidate || "").trim()).filter(Boolean);
}

function matchesAdminHistoryTarget(candidate: string, target: string) {
  const normalizedCandidate = candidate.toLowerCase();
  const normalizedTarget = target.toLowerCase();
  if (normalizedCandidate === normalizedTarget) return true;
  const masked = normalizedTarget.match(/^(.{4,})\.\.\.(.{4,})$/);
  if (!masked) return false;
  return normalizedCandidate.startsWith(masked[1]) && normalizedCandidate.endsWith(masked[2]);
}

function friendlyAdminHistorySummary(friendly: string, path: string, payload: string, command = "") {
  const label = String(friendly || "").replace(/\bpublish test\b/gi, "").replace(/\s+/g, " ").trim();
  const parsed = parseJsonMaybe(payload) as { messagePreview?: unknown } | null;
  const message = parsed?.messagePreview;
  const messageText = typeof message === "string" && message.trim() ? `: "${message.trim().slice(0, 80)}${message.trim().length > 80 ? "..." : ""}"` : "";
  if (/broadcast/i.test(label) || /^web-(broadcast|shutdown-broadcast)$/i.test(String(command || ""))) return `Broadcast${messageText}`;
  if (/hydrate/i.test(label) || /^web-hydrate-all$/i.test(String(command || ""))) return "Hydrated online players";
  if (/kick/i.test(label)) return "Kick command";
  if (/grant/i.test(label)) return label || "Grant command";
  if (label) return label;
  if (/rmq/i.test(path)) return "RabbitMQ command";
  return "Admin command";
}

function parseJsonMaybe(text: string) {
  if (!text.trim().startsWith("{") && !text.trim().startsWith("[")) return null;
  try { return JSON.parse(text); } catch { return null; }
}
