import type { ReactNode } from "react";
import { KeyValueGrid, PlayerStatusCell } from "../../components/common/DisplayPrimitives";
import { firstDefined } from "../../lib/display";

export function PlayerSummary({
  detail,
  fallback,
  dbPlayerId,
  actionPlayerId,
  actions
}: {
  detail: Record<string, unknown> | null;
  fallback: Record<string, unknown>;
  dbPlayerId: string;
  actionPlayerId: string;
  actions?: ReactNode;
}) {
  const player = ((detail?.player as Record<string, unknown> | undefined) || fallback) as Record<string, unknown>;
  const status = firstDefined(player.online_status, fallback.online_status);

  return <section className="action-section">
    <h4>Player Summary</h4>
    <KeyValueGrid items={[
      ["Character", firstDefined(player.character_name, player.name, fallback.character_name)],
      ["Status", <PlayerStatusCell value={status} />],
      ["Map", firstDefined(player.map, player.world, fallback.map)],
      ["DB actor/player ID", dbPlayerId || "missing"],
      ["Admin action ID", actionPlayerId || "missing"],
      ["Account ID", firstDefined(player.account_id, fallback.account_id)],
      ["Funcom/FLS ID", firstDefined(player.funcom_id, player.fls_id, fallback.funcom_id, fallback.fls_id)],
      ["Controller ID", firstDefined(player.player_controller_id, fallback.player_controller_id)]
    ]} />
    {actions}
  </section>;
}
