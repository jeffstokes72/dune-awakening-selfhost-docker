import test from "node:test";
import assert from "node:assert/strict";
import { parseHomeStatus, parsePortRows, parseReadyRows } from "../src/statusParsers.js";

const healthyStatus = `=== Dune status ===
Overall:     READY
Title:       My Local Dune
Region:      Europe
Mode:        public
Server IP:   37.76.210.36
Battlegroup: test-bg
Population:  0/60

=== Database ===
World partitions: 30

=== RabbitMQ game connections ===
Director connections:    1
Game server connections: 4
TextRouter connections:  0

=== Funcom/FLS summary ===
Director heartbeat:       OK
Population declaration:   OK
Max capacity declaration: OK
Gateway DB monitoring:    OK`;

test("healthy home status does not create false warnings", () => {
  const summary = parseHomeStatus(healthyStatus);
  assert.equal(summary.population, "0/60");
  assert.equal(summary.database, "Ready");
  assert.equal(summary.rabbitmq, "Ready");
  assert.equal(summary.fls, "Ready");
});

test("ready parser ignores section headings and keeps only check rows", () => {
  const rows = parseReadyRows(`=== Container checks ===
OK   container dune-postgres
OK   container dune-rmq-game

=== Listener checks ===
OK   TCP 15432 Postgres localhost
OK   world_partition rows: 30
READY: Dune Awakening Self-Host Docker stack looks healthy.`);
  assert.deepEqual(rows.map((row) => row.label), [
    "container dune-postgres",
    "container dune-rmq-game",
    "TCP 15432 Postgres localhost"
  ]);
});

test("port parser ignores diagnostics and deduplicates logical listeners", () => {
  const rows = parsePortRows(`=== Expected endpoints ===
Overmap game          7777/udp       advertised as 37.76.210.36:7777
WARN Public mode advertises 37.76.210.36 while game UDP is bound on private host IP 10.0.0.5.
OK   Overmap game listening on UDP 7777
OK   Survival_1 game listening on UDP 7778
OK   Survival_1 IGW listening on UDP 7888
OK   Overmap IGW listening on UDP 7889
OK   RabbitMQ game listening on TCP 31982
OK   RabbitMQ game listening on TCP 31982`);
  assert.deepEqual(rows.map((row) => `${row.name}:${row.port}/${row.protocol}`), [
    "Overmap game:7777/UDP",
    "Survival_1 game:7778/UDP",
    "Survival_1 IGW:7888/UDP",
    "Overmap IGW:7889/UDP",
    "RabbitMQ game:31982/TCP"
  ]);
});
