import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { addonsApi, type CommunityAddonSummary, type InstalledAddon } from "../../api/addons";

export type PinnedAddon = Pick<InstalledAddon, "id" | "name" | "entryPath" | "enabled">;

type AddonsPanelProps = {
  pinnedAddons: PinnedAddon[];
  setPinnedAddons: Dispatch<SetStateAction<PinnedAddon[]>>;
  selectedAddonId: string;
  clearSelectedAddon: () => void;
  setAddonCount: Dispatch<SetStateAction<number>>;
  confirmAction: (message: string, options?: { danger?: boolean; confirmLabel?: string }) => Promise<boolean>;
};

export function AddonsPanel({ pinnedAddons, setPinnedAddons, selectedAddonId, clearSelectedAddon, setAddonCount, confirmAction }: AddonsPanelProps) {
  const [addons, setAddons] = useState<CommunityAddonSummary[]>([]);
  const [installed, setInstalled] = useState<InstalledAddon[]>([]);
  const [loading, setLoading] = useState(false);
  const [installedLoaded, setInstalledLoaded] = useState(false);
  const [installingId, setInstallingId] = useState("");
  const [busyAddonId, setBusyAddonId] = useState("");
  const [openAddonId, setOpenAddonId] = useState("");
  const [expandedDescriptions, setExpandedDescriptions] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<{ title: string; message: string; tone: "ok" | "fail" } | null>(null);

  async function load() {
    setLoading(true);
    setNotice(null);
    try {
      const [result, installedResult] = await Promise.all([addonsApi.community(), addonsApi.installed()]);
      setAddons(result.addons || []);
      setAddonCount((result.addons || []).length);
      setInstalled(installedResult.addons || []);
      setInstalledLoaded(true);
    } catch (err) {
      setNotice({ title: "Addons Unavailable", message: formatAddonError(err), tone: "fail" });
      setAddons([]);
      setAddonCount(0);
      setInstalled([]);
      setInstalledLoaded(false);
    } finally {
      setLoading(false);
    }
  }

  async function installAddon(addon: CommunityAddonSummary) {
    if (!(await confirmAction(`Install ${addon.name}? The addon archive will be downloaded from the reviewed release URL and verified before extraction.`))) return;
    setInstallingId(addon.id);
    setNotice(null);
    try {
      const result = await addonsApi.installCommunity(addon.id);
      await load();
      setNotice({ title: "Addon Installed", message: `${result.addon.name} was installed successfully.`, tone: "ok" });
    } catch (err) {
      setNotice({ title: "Install Failed", message: formatAddonError(err), tone: "fail" });
    } finally {
      setInstallingId("");
    }
  }

  async function setAddonEnabled(addon: InstalledAddon, enabled: boolean) {
    setBusyAddonId(addon.id);
    setNotice(null);
    try {
      const result = enabled ? await addonsApi.enable(addon.id) : await addonsApi.disable(addon.id);
      await load();
      setNotice({
        title: enabled ? "Addon Enabled" : "Addon Disabled",
        message: `${result.addon.name} was ${enabled ? "enabled" : "disabled"}.`,
        tone: "ok"
      });
    } catch (err) {
      setNotice({ title: enabled ? "Enable Failed" : "Disable Failed", message: formatAddonError(err), tone: "fail" });
    } finally {
      setBusyAddonId("");
    }
  }

  async function removeAddon(addon: InstalledAddon) {
    if (!(await confirmAction(`Uninstall ${addon.name}? This deletes the local installed addon files.`, { danger: true, confirmLabel: "Uninstall" }))) return;
    setBusyAddonId(addon.id);
    setNotice(null);
    try {
      await addonsApi.remove(addon.id);
      if (openAddonId === addon.id) setOpenAddonId("");
      await load();
      setNotice({ title: "Addon Uninstalled", message: `${addon.name} was uninstalled.`, tone: "ok" });
    } catch (err) {
      setNotice({ title: "Uninstall Failed", message: formatAddonError(err), tone: "fail" });
    } finally {
      setBusyAddonId("");
    }
  }

  function toggleAddonPin(addon: InstalledAddon, pinned: boolean) {
    if (pinned) {
      setPinnedAddons((current) => current.some((item) => item.id === addon.id) ? current : [...current, { id: addon.id, name: addon.name, entryPath: addon.entryPath, enabled: addon.enabled }]);
    } else {
      setPinnedAddons((current) => current.filter((item) => item.id !== addon.id));
      if (selectedAddonId === addon.id) clearSelectedAddon();
      if (openAddonId === addon.id) setOpenAddonId("");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (selectedAddonId) setOpenAddonId(selectedAddonId);
  }, [selectedAddonId]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const installedById = new Map(installed.map((addon) => [addon.id, addon]));
  const openAddon = installed.find((addon) => addon.id === openAddonId && addon.enabled);

  useEffect(() => {
    if (!installedLoaded) return;
    setPinnedAddons((current) => current
      .map((item) => {
        const installedAddon = installed.find((addon) => addon.id === item.id && addon.enabled);
        return installedAddon ? { id: installedAddon.id, name: installedAddon.name, entryPath: installedAddon.entryPath, enabled: installedAddon.enabled } : null;
      })
      .filter((item): item is PinnedAddon => Boolean(item)));
  }, [installed, installedLoaded, setPinnedAddons]);

  useEffect(() => {
    if (!openAddon) return undefined;
    const activeAddon = openAddon;
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      const request = normalizeAddonBridgeRequest(event.data);
      if (!request || request.addonId !== activeAddon.id) return;
      const source = event.source as Window | null;
      if (!source) return;
      void (async () => {
        try {
          if (request.action !== "leadership.players.list") throw new Error(`Unsupported addon action: ${request.action}`);
          if (!activeAddon.permissions.includes("players:read")) throw new Error(`${activeAddon.name} does not have players:read permission.`);
          const result = await addonsApi.leadershipPlayers();
          source.postMessage({ type: "dune-addon-response", requestId: request.requestId, ok: true, result }, event.origin);
        } catch (err) {
          source.postMessage({ type: "dune-addon-response", requestId: request.requestId, ok: false, error: formatAddonError(err) }, event.origin);
        }
      })();
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [openAddon]);

  const rows = addons.map((addon) => {
    const installedAddon = installedById.get(addon.id);
    return { ...addon, status: installedAddon ? installedAddon.status || "Installed" : "Available" };
  });

  if (selectedAddonId) {
    return <section className="panel addon-view-panel">
      {openAddon
        ? <>
          <div className="panel-title"><h2>{openAddon.name}</h2></div>
          <iframe className="addon-frame" title={openAddon.name} src={addonContentUrl(openAddon)} />
        </>
        : <div className="result-panel result-fail"><strong>Addon unavailable.</strong><p>This pinned addon is not installed, enabled, or fully loaded yet.</p></div>}
    </section>;
  }

  return <section className="panel">
    <div className="panel-title"><h2>Addons <span className="addons-title-status">(Experimental: Read-Only)</span></h2><div className="addons-title-actions"><a className="button-link" href="https://github.com/Red-Blink/dune-docker-addons" target="_blank" rel="noreferrer">For Developers</a><button disabled={loading} onClick={() => void load()}>{loading ? "Refreshing..." : "Refresh Addons"}</button></div></div>
    <section className="action-section info-panel addons-intro-panel">
      <h4>Community Addons</h4>
      <div className="addons-owner-copy">
        <p>Add community-built tools to your Dune Docker Console. Install the addons you trust, turn them on when you need them, and keep your console focused on the features your server actually uses.</p>
      </div>
    </section>
    {notice && <div className={`result-panel addon-result-panel result-${notice.tone}`}><strong>{notice.title}.</strong><p>{notice.message}</p></div>}
    <AddonsTable
      rows={rows}
      loading={loading}
      installedById={installedById}
      pinnedAddons={pinnedAddons}
      installingId={installingId}
      busyAddonId={busyAddonId}
      openAddonId={openAddonId}
      expandedDescriptions={expandedDescriptions}
      setExpandedDescriptions={setExpandedDescriptions}
      installAddon={installAddon}
      setAddonEnabled={setAddonEnabled}
      removeAddon={removeAddon}
      setOpenAddonId={setOpenAddonId}
      toggleAddonPin={toggleAddonPin}
    />
    {openAddon && <section className="action-section">
      <div className="panel-title"><h4>{openAddon.name}</h4></div>
      <iframe className="addon-frame" title={openAddon.name} src={addonContentUrl(openAddon)} />
    </section>}
  </section>;
}

function AddonsTable({ rows, loading, installedById, pinnedAddons, installingId, busyAddonId, openAddonId, expandedDescriptions, setExpandedDescriptions, installAddon, setAddonEnabled, removeAddon, setOpenAddonId, toggleAddonPin }: {
  rows: CommunityAddonSummary[];
  loading: boolean;
  installedById: Map<string, InstalledAddon>;
  pinnedAddons: PinnedAddon[];
  installingId: string;
  busyAddonId: string;
  openAddonId: string;
  expandedDescriptions: Record<string, boolean>;
  setExpandedDescriptions: Dispatch<SetStateAction<Record<string, boolean>>>;
  installAddon: (addon: CommunityAddonSummary) => void;
  setAddonEnabled: (addon: InstalledAddon, enabled: boolean) => void;
  removeAddon: (addon: InstalledAddon) => void;
  setOpenAddonId: Dispatch<SetStateAction<string>>;
  toggleAddonPin: (addon: InstalledAddon, pinned: boolean) => void;
}) {
  if (!rows.length) return <div className="empty">{loading ? "Loading community addons..." : "No community addons are listed yet."}</div>;
  return <div className="table-wrap"><table className="addons-table"><thead><tr><th>Name</th><th>Description</th><th>Author</th><th>Version</th><th>Status</th><th className="backup-table-actions">Actions</th><th className="addon-pin-column">Sub-Menu</th></tr></thead><tbody>{rows.map((row) => {
    const installedAddon = installedById.get(row.id);
    const busy = busyAddonId === row.id;
    const pinned = Boolean(installedAddon && pinnedAddons.some((addon) => addon.id === installedAddon.id));
    return <tr key={row.id}>
      <td><strong>{row.name}</strong></td>
      <td><AddonDescriptionCell value={row.description} expanded={Boolean(expandedDescriptions[row.id])} onToggle={() => setExpandedDescriptions((current) => ({ ...current, [row.id]: !current[row.id] }))} /></td>
      <td>{row.author}</td>
      <td>{row.version}</td>
      <td>{installedAddon ? <div className="addon-status-cell"><label className={`switch-checkbox addon-status-toggle ${installedAddon.enabled ? "enabled" : "disabled"}`}><input type="checkbox" disabled={busy} checked={installedAddon.enabled} onChange={(event) => void setAddonEnabled(installedAddon, event.target.checked)} /><span className="switch-label">{busy ? "Working" : installedAddon.enabled ? "Enabled" : "Disabled"}</span><strong className="switch-state">{installedAddon.enabled ? "ON" : "OFF"}</strong></label></div> : <div className="addon-status-cell"><StatusPill value="Available" /></div>}</td>
      <td className="backup-table-actions"><div className="service-actions">
        {!installedAddon && <button disabled={installingId === row.id} onClick={() => void installAddon(row)}>{installingId === row.id ? "Installing..." : "Install"}</button>}
        {installedAddon?.enabled && <button disabled={busy} onClick={() => setOpenAddonId(openAddonId === installedAddon.id ? "" : installedAddon.id)}>{openAddonId === installedAddon.id ? "Close" : "Open"}</button>}
        {installedAddon && <button className="danger" disabled={busy} onClick={() => void removeAddon(installedAddon)}>Uninstall</button>}
      </div></td>
      <td className="addon-pin-column">{installedAddon?.enabled
        ? <label className={`switch-checkbox addon-pin-toggle ${pinned ? "enabled" : "disabled"}`}><input type="checkbox" checked={pinned} onChange={(event) => toggleAddonPin(installedAddon, event.target.checked)} /><strong className="switch-state">{pinned ? "ON" : "OFF"}</strong></label>
        : <span className="muted">-</span>}</td>
    </tr>;
  })}</tbody></table></div>;
}

function StatusPill({ value }: { value: unknown }) {
  const text = String(value ?? "");
  const normalized = text.toLowerCase();
  const kind = normalized.includes("ready") || normalized.includes("running") || normalized.includes("ok") || normalized.includes("enabled") || normalized.includes("available") ? "ok"
    : normalized.includes("fail") || normalized.includes("missing") || normalized.includes("stopped") || normalized.includes("disabled") || normalized.includes("error") ? "bad"
      : "warn";
  return <span className={`badge ${kind}`}>{text || "Unknown"}</span>;
}

function normalizeAddonBridgeRequest(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.type !== "dune-addon-request") return null;
  const addonId = typeof record.addonId === "string" ? record.addonId : "";
  const requestId = typeof record.requestId === "string" ? record.requestId : "";
  const action = typeof record.action === "string" ? record.action : "";
  if (!addonId || !requestId || !action) return null;
  return { addonId, requestId, action };
}

function AddonDescriptionCell({ value, expanded, onToggle }: { value: unknown; expanded: boolean; onToggle: () => void }) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const canExpand = text.length > 96;
  const preview = canExpand && !expanded ? `${text.slice(0, 96).replace(/\s+\S*$/, "")}.....` : text;
  return <div className={`addon-description-field ${expanded ? "expanded" : ""}`}>
    {canExpand ? <button className="playerAdmin_expanderButton addon-description-toggle" type="button" onClick={onToggle}>{expanded ? "-" : "+"}</button> : <span className="playerAdmin_expanderSpacer addon-description-spacer" />}
    <span>{preview}</span>
  </div>;
}

function addonContentUrl(addon: InstalledAddon) {
  return `/api/addons/installed/${encodeURIComponent(addon.id)}/content/${addon.entryPath.split("/").map(encodeURIComponent).join("/")}`;
}

function formatAddonError(value: unknown) {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "Action failed.";
  }
}

export function loadPinnedAddons(): PinnedAddon[] {
  try {
    const raw = window.localStorage.getItem("dunePinnedAddons");
    const parsed = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => ({
        id: typeof item?.id === "string" ? item.id : "",
        name: typeof item?.name === "string" ? item.name : "",
        entryPath: typeof item?.entryPath === "string" ? item.entryPath : "",
        enabled: item?.enabled === true
      }))
      .filter((item) => item.id && item.name && item.entryPath && item.enabled);
  } catch {
    return [];
  }
}

export function savePinnedAddons(addons: PinnedAddon[]) {
  try {
    window.localStorage.setItem("dunePinnedAddons", JSON.stringify(addons));
  } catch {
    // Browser storage can be unavailable in hardened modes.
  }
}
