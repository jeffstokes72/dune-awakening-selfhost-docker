import type { Check } from "../api/setup";
import { StatusBadge } from "./StatusBadge";

export function PreflightCheckCard({ check }: { check: Check }) {
  return (
    <article className="check-card">
      <div>
        <h4>{check.name}</h4>
        <p>{check.message}</p>
      </div>
      <StatusBadge status={check.status} />
    </article>
  );
}
