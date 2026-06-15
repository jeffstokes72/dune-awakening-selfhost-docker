import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { playersApi } from "../../api/players";
import { DataTable } from "../../components/common/DataTable";
import { PlayerStatusCell } from "../../components/common/DisplayPrimitives";
import { formatCell } from "../../lib/display";

export type CharacterAdminRenderProps = {
  detail: Record<string, unknown> | null;
  fallback: Record<string, unknown>;
  dbPlayerId: string;
  actionPlayerId: string;
  playerName: string;
  onRefresh: () => void;
  onClose: () => void;
};

type PlayersPanelProps = {
  onError: (text: string) => void;
  renderCharacterAdmin: (props: CharacterAdminRenderProps) => ReactNode;
};

export function PlayersPanel({ onError, renderCharacterAdmin }: PlayersPanelProps) {
  const [q, setQ] = useState("");
  const [playerFilter, setPlayerFilter] = useState<"all" | "online" | "offline">("all");
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);

  async function load(filter = playerFilter) {
    onError("");
    try {
      const result = filter === "online" ? await playersApi.online() : await playersApi.list(q);
      const nextRows = result.rows || [];
      setRows(filter === "offline"
        ? nextRows.filter((row) => String(row.online_status || "").toLowerCase() !== "online")
        : nextRows);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  async function open(row: Record<string, unknown>) {
    const id = String(row.actor_id || row.player_pawn_id || row.id || "");
    setSelected(row);
    setDetail(await playersApi.profile(id));
  }

  useEffect(() => {
    void load("all");
  }, []);

  const dbPlayerId = selected ? String(selected.actor_id || selected.player_pawn_id || selected.id || "") : "";
  const actionPlayerId = selected ? String(selected.action_player_id || selected.funcom_id || selected.fls_id || selected.account_id || "") : "";
  const playersEmptyMessage = playerFilter === "online"
    ? "No players are currently online."
    : playerFilter === "offline"
      ? "No offline players were found."
      : "No players have been found yet.";

  return (
    <section className="panel">
      <div className="panel-title"><h2>Players</h2><div className="action-row players-filter-row"><label className="inline-filter-label players-filter-label">Filter <select className="players-filter-select" value={playerFilter} onChange={(event) => { const nextFilter = event.target.value as "all" | "online" | "offline"; setPlayerFilter(nextFilter); void load(nextFilter); }}><option value="all">All Players</option><option value="online">Online</option><option value="offline">Offline</option></select></label><button onClick={() => void load(playerFilter)}>Refresh</button></div></div>
      <div className="action-row"><input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Search character, FLS ID, account id, or actor id" /><button onClick={() => void load(playerFilter)}>Search</button></div>
      <DataTable rows={rows} columns={["actor_id", "character_name", "account_id", "action_player_id", "online_status", "map", "fls_id"]} tableClassName="players-table" onRowClick={open} emptyMessage={playersEmptyMessage} renderCell={(row, col) => col === "online_status" ? <PlayerStatusCell value={row[col]} /> : formatCell(row[col])} />
      {selected && renderCharacterAdmin({
        detail,
        fallback: selected,
        dbPlayerId,
        actionPlayerId,
        playerName: String(selected.character_name || actionPlayerId || dbPlayerId || "Selected player"),
        onRefresh: () => { void open(selected); },
        onClose: () => setSelected(null)
      })}
    </section>
  );
}
