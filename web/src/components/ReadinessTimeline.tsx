export function ReadinessTimeline({ text }: { text: string }) {
  const checks = parseChecks(text);
  const groups = groupChecks(checks);
  return <section className="action-section">
    <h4>Readiness Checklist</h4>
    {checks.length ? <div className="readiness-groups">{Object.entries(groups).map(([group, rows]) => rows.length ? <section className="readiness-group" key={group}>
      <h5>{group}</h5>
      <div className="check-grid">{rows.map((check, index) => <article className="check-card" key={`${check.name}-${index}`}>
        <div><strong>{check.name}</strong><p>{check.detail}</p></div>
        <span className={`badge badge-${check.kind}`}>{check.status}</span>
      </article>)}</div>
    </section> : null)}</div> : <p>Readiness has not been checked yet.</p>}
  </section>;
}

function parseChecks(text: string) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).filter((line) => {
    if (/^=== .+ ===$/.test(line)) return false;
    if (/^(READY|WARMING|NOT READY):/i.test(line)) return false;
    if (/^Note:|^Tip:|^Run again|^After READY|^Possible runtime/i.test(line)) return false;
    if (/^\s*dune ready\s*$/i.test(line)) return false;
    if (/^This is normal|^Game server containers|^Director is running|^Gateway is running|^Fresh init/i.test(line)) return false;
    return /^(OK|WAIT|FAIL)\s+/i.test(line);
  }).slice(0, 80).map((line) => {
    const status = /^FAIL\s+/i.test(line) ? "Failed" : /^WAIT\s+/i.test(line) ? "Warn" : "Ready";
    const name = friendlyCheckName(line);
    return {
      name,
      detail: detailForCheck(line, name),
      status,
      kind: status === "Ready" ? "pass" : status === "Failed" ? "fail" : "warn"
    };
  }).filter((check) => check.name);
}

function groupChecks(checks: ReturnType<typeof parseChecks>) {
  return checks.reduce<Record<string, typeof checks>>((groups, check) => {
    const text = `${check.name} ${check.detail}`.toLowerCase();
    let group = "Other Checks";
    if (/database|partition|world/.test(text)) group = "";
    else if (/listener|port|tcp|udp|listen/.test(text)) group = "Listener Checks";
    else if (/rabbit|rmq|sg\b|connections/.test(text)) group = "RabbitMQ Game Connections";
    else if (/fls|funcom|heartbeat|population declaration|max capacity|gateway db|monitoring/.test(text)) group = "Funcom/FLS Summary";
    else if (/dynamic|idle|map/.test(text)) group = "Dynamic Game Map";
    else if (/dune postgres|rabbitmq admin|rabbitmq game|text router|dune director|^gateway$|^survival 1$|^overmap$|orchestrator/.test(text)) group = "Container Checks";
    else if (/ready|warming|server|survival|overmap/.test(text)) group = "Game Server Checks";
    if (!group) return groups;
    groups[group] ||= [];
    groups[group].push(check);
    return groups;
  }, {
    "Container Checks": [],
    "Listener Checks": [],
    "Game Server Checks": [],
    "RabbitMQ Game Connections": [],
    "Funcom/FLS Summary": [],
    "Dynamic Game Map": [],
    "Other Checks": []
  });
}

function friendlyCheckName(line: string) {
  return line
    .replace(/^(OK|PASS|READY|WARN|WAIT|FAIL|FAILED|ERROR|MISSING)\s+/i, "")
    .replace(/^container\s+/i, "")
    .replace(/^listener\s+/i, "")
    .replace(/^database\s+/i, "Database ")
    .replace(/^tcp\s+([0-9]+)\s+/i, "TCP $1 ")
    .replace(/^udp\s+([0-9]+)\s+/i, "UDP $1 ")
    .replace(/dune-postgres/gi, "Dune Postgres")
    .replace(/dune-rmq-admin/gi, "RabbitMQ Admin")
    .replace(/dune-rmq-game/gi, "RabbitMQ Game")
    .replace(/dune-text-router/gi, "Text Router")
    .replace(/dune-director/gi, "Dune Director")
    .replace(/dune-server-gateway/gi, "Gateway")
    .replace(/dune-server-survival-1/gi, "Survival 1")
    .replace(/dune-server-overmap/gi, "Overmap")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detailForCheck(line: string, name: string) {
  if (/^OK|^PASS|^READY/i.test(line)) return "";
  const clean = line.replace(/^(WAIT|FAIL)\s+/i, "").replace(/\s+/g, " ").trim();
  return clean === name ? "Attention needed" : clean;
}
