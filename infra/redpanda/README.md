# infra/redpanda — topics, retention and the dead-letter convention

Owner: window 14 (events). Issue #530 (Phase 4, task 14.1). Design: ADR 0003 (`docs/adr/0003-outbox-events.md`).
The code behind this folder lives in `packages/events/src/topics.ts` (public API of `@platform/events`); this
folder holds the entrypoint, the policy numbers and this document.

## Files

| File                 | What                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| `create-topics.mjs`  | Creates every topic idempotently through the Kafka admin API. `--env`, `--dry-run`, `--brokers`.             |
| `topics.policy.json` | Partitions and replication per environment, retention classes, the DLQ prefix and the known consumer groups. |

The topic **list** is not in this folder on purpose: it is derived from `EVENT_TOPICS` in `packages/events`
(one topic per `schemas/<topic>/` directory). A new schema directory is a new topic the next time the script
runs; a new schema without a retention class fails `pnpm --filter @platform/events test` before that.

## Ports (local compose stack, `infra/docker/docker-compose.yml`)

| Port  | API                       | Used by                                                                        |
| ----- | ------------------------- | ------------------------------------------------------------------------------ |
| 19092 | Kafka (external listener) | the relay, consumers, this script (`KAFKA_BROKERS`, default `127.0.0.1:19092`) |
| 18081 | Schema registry           | #532                                                                           |
| 18082 | HTTP proxy (pandaproxy)   | nothing yet                                                                    |
| 9644  | Redpanda admin API        | health checks: `curl 127.0.0.1:9644/v1/cluster/health_overview`                |

The broker advertises `localhost:19092`. Node 20 resolves `localhost` to `::1` first and Docker Desktop's
IPv6 loopback proxy drops now and then while IPv4 keeps working (the same gotcha as the `DATABASE_URL`
rows), so `createKafka()` pins every `localhost` connection to `127.0.0.1` through a socket factory.
`KAFKA_BROKERS` itself should name `127.0.0.1:19092` locally.

## Create the topics locally

```bash
pnpm --filter @platform/events topics:create
```

(builds the package, then runs `node infra/redpanda/create-topics.mjs`). Direct form, once built:

```bash
node infra/redpanda/create-topics.mjs --env local
```

`--env production` refuses to run unless `--brokers` names a non-loopback cluster (against the local broker it would
raise the shared topics to 12 partitions and then fail on the budget). `--dry-run` prints what would change and touches nothing. The script prints one JSON summary line
(`created`, `altered`, `partitions_raised`, `unchanged`, `warnings`) and one line per change. A second run
prints `created 0, altered 0, partitions_raised 0`. The script never deletes a topic.

The compose stack starts Redpanda in `dev-container` mode, which has `auto_create_topics_enabled=true`: a
producer or consumer that names a topic before this script ran gets a topic with the broker defaults
(1 partition, 7-day retention). Run the script first; the relay (#531) refuses to start against a broker
that lacks a topic it needs rather than letting auto-creation decide the numbers.

## Every choice and why

**Topic name = event topic, verbatim** (`order.placed`). One name across the schema directory, the outbox
`topic` column, the registry subject (#532) and the bus; nothing to map. Kafka folds `.` and `_` into one
metric name (`order_placed`), so the plan rejects two topics that collide there (`stock.moved` vs a
hypothetical `stock_moved`); the test asserts the current 38 are collision-free.

**Partition key = `store_id`.** All events of one store land on one partition, so a consumer sees them in the
order the outbox `seq` gave them (the relay publishes in `seq` order and waits for the ack before marking the
row). Events of different stores may interleave; nothing today needs cross-store order (ADR 0003).

**Organization-scope events (`store_id` null)** — `store.created`, `stock.moved` on a shared warehouse,
`customer.export_requested` for an HQ export, … — are keyed by `organization_id`. They are ordered among
themselves per organization, and **not** ordered relative to any store's stream: a consumer that needs
"store.created before the first order.placed of that store" must handle the order event arriving first
(look the store up, or buffer). The alternative, keying every org-scope event into one fixed partition,
would serialize every organization through one partition for no ordering gain.

**Message key vs idempotency key.** ADR 0003 says "key = event_id"; issue #530/#531 refines that: the
_partition_ key is `store_id` (ordering), the _idempotency_ key is the outbox id and travels as a message
header (`outbox_id`) that consumers dedupe on. The ADR text is the manager's to update (docs/).

**Partitions: 1 locally and in CI, 12 in production.** The compose broker runs with `--memory=512M` and
Redpanda reserves `topic_memory_per_partition` = 4 MiB per partition, so the dev container has a hard
budget of about **128 partitions in total** (the broker answers `Number of partitions is invalid` beyond
it; measured 2026-10-20: 115 existing + 4 more topics of 3 was the ceiling). With 38 event topics that
budget only works at 1 partition each (38), which leaves ~85 for the schema registry's `_schemas`, the
dead-letter topics and the prefixed topics the tests create and delete. One partition keeps every ordering
guarantee trivially; the multi-partition path (key hashing, per-partition order, consumer parallelism) is
exercised by tests that create their own prefixed topics with more partitions and, in production, by 12.
12 in production gives 12-way consumer parallelism per topic for the three stores we start with plus
headroom; stores hash across partitions, so a count larger than the number of stores costs nothing. A
count can be raised later (the script does it when the policy rises), never lowered (Kafka cannot; the
script warns and leaves it). The broker also reclaims deleted partitions asynchronously, so a create that
follows a delete can be refused for a moment: `ensureTopics` retries the refused topics (6 attempts,
0.5 s → 2.5 s) and reports the retry as a warning.

**Replication: 1 locally/CI, 3 in production with `min.insync.replicas=2`.** One node locally. In production a
producer with `acks=all` then needs two replicas to acknowledge, so one broker can be lost without losing an
acknowledged event.

**Retention, two classes (ADR 0003 item 3).** `forever` (`retention.ms=-1`) for everything accounting and
inventory derive from: `order.*`, `payment.*`, `refund.*`, `shipment.*`, `return.*`, `stock.*`,
`stock_item.*`. `days_30` (`retention.ms=2592000000`) for the rest: `store.*`, `product.*`, `customer.*`,
`fulfillment.*`, `campaign.*`, `feed.*`, `attribution.*`, `referral.*`, `review.*`, `cart.*`. The bus is not
the archive: the outbox table is the source of truth and the replay CLI (#534) republishes from it, so a
30-day topic is a delivery window, not a history. `customer.erased` sits in the 30-day class on purpose: a
consumer that was down for a month re-syncs from the outbox replay, which carries it.

**Cleanup policy `delete`** on every event topic (never `compact`: compaction would drop earlier events of
the same key, and our key is the store).

**Dead-letter topics: `dlq.<groupId>`, one per consumer group, `cleanup.policy=compact`, kept forever.**
A failed message is written to the group's DLQ with key = the outbox id and a value that carries the error
class, the topic, the outbox id and the attempt count — never the payload (no PII on a topic that
operators read). Compacted so the _latest_ failure per event is what remains, and a successful replay
writes a tombstone (null value) for that key, which compaction removes: the DLQ is the live list of what
is still failing. One DLQ per group because retries and replays are a per-consumer decision. The script
creates the DLQs for the groups listed in `topics.policy.json` (none yet) and the consumer SDK (#533)
creates its own group's DLQ on first start with the same `dlqTopicName`/`ensureTopics` helpers, so a new
consumer needs no infra change.

**Idempotency of the script.** `listTopics` decides what exists; missing topics are created in one
`CreateTopics` call with their configs; existing ones are compared (`DescribeConfigs` on the managed keys,
metadata for the partition count) and only a drift is sent (`AlterConfigs`, `CreatePartitions`). The
managed keys are `cleanup.policy`, `retention.ms` and, in production, `min.insync.replicas`; every other
broker config stays at its default. `AlterConfigs` is the non-incremental form (kafkajs has no
`IncrementalAlterConfigs`): it sets the whole non-default config of the topic, which is exactly the
managed set, so it is not lossy for us.

**Client library: kafkajs 2.2.4.** Pure JavaScript, works on Node 20 (this laptop and CI's `NODE_VERSION`);
`@platformatic/kafka` needs Node ≥ 22.22, `@confluentinc/kafka-javascript` is native librdkafka (a build
risk on Windows). kafkajs is in maintenance mode, so it stays behind the `@platform/events` public API
(`createKafka`, `ensureTopics`, the relay and consumer SDK): a swap touches one package.

## Tests

`pnpm --filter @platform/events test` — `test/topics.test.ts`:

- pure: the policy covers every schema (fails on a new schema without a class), retention per ADR, plan
  derivation and configs, production `min.insync.replicas`, DLQ naming, metric-name collisions, the key rule.
- live, `describe.runIf(broker reachable)`: a dry run touches nothing; the first run creates every topic with
  the right partitions/retention/cleanup; the second run changes nothing; a drifted config is altered and
  only that one; a raised partition count is applied and a lowered one warns. It works under a random
  prefix (`t-abc123.order.placed`) and deletes only its own topics, so the shared local broker's real topics
  are never touched. When the broker is down the file prints
  `topics.test: broker 127.0.0.1:19092: ECONNREFUSED — live block skipped` and the block is skipped.

## What CI needs

Today the `unit` job has Postgres only, so the live block skips there with the printed reason. For CI to
run it, the `auth-e2e` job's compose boot line gains `redpanda` (`… up -d postgres redis keycloak openfga
redpanda`), `wait-for-auth-stack.sh` probes `127.0.0.1:9644/v1/cluster/health_overview`, the job sets
`KAFKA_BROKERS=127.0.0.1:19092`, runs `create-topics.mjs --env ci`, then runs the events tests with
`infra/ci/require-live-tests.mjs` naming the describe title `ensureTopics against the local Redpanda
(prefixed, self-cleaning)` so a probe that misses fails the step instead of skipping. Those files are
window 5's and the manager's: filed as a REQUEST after the #530 PR. The relay tests (#531) and the 10k
replay test (#534) will run in the same job.

## Schema registry (#532)

`register-schemas.mjs` registers every event schema in the registry on **18081** (`SCHEMA_REGISTRY_URL`),
idempotently: `node infra/redpanda/register-schemas.mjs [--dry-run] [--url …]` or
`pnpm --filter @platform/events schemas:register`. One JSON summary line; a second run prints `registered 0`.

**Subjects: one per (topic, version), `<topic>-v<N>-value`, compatibility BACKWARD on each.** Measured on
Redpanda 24.2.7: our existing v2 schemas are breaking against their v1 by design (`stock.moved` v2 requires
`stock_item_id`, `customer.export_requested` v2 requires `requested_by_type`), so one subject per topic with
BACKWARD across versions would refuse the next such version at registration. Per-version subjects make
BACKWARD mean exactly our rule — a published version only evolves compatibly — while a new version is a new
file, a new subject, free to break (consumers handle both, ADR 0003).

**Registered schemas are inlined.** Every schema references `common/v1.json#/$defs/…`, and Redpanda 24.2's JSON
compatibility checker rejects any schema containing `$ref` (`is_superset not fully implemented yet. unsupported
keyword: $ref`). The registered copy has the common definitions substituted in (`inlineCommonRefs`), so the
registry can judge it; `$id` is kept.

**The registry is the second opinion, not the gate.** Measured with inlined schemas: it catches a removed
property, a type change and a narrowed enum, but accepts an added required property (old data lacks it). The
package's own checker (`backwardIncompatibilities`) and the published lock (`packages/events/schemas/published.lock.json`,
compared in `pnpm --filter @platform/events test` with no registry) are what fail CI; the live registry test pins
the registry's verdicts so a Redpanda upgrade that closes the gap shows up as a test to update.

**On the wire:** the relay resolves every `topic@version` to its registry id at start (refuses to start when the
registry is unreachable or lacks a schema; `--no-registry` for runbooks) and stamps it as the `schema_id` header.

**CI:** after `create-topics.mjs --env ci` in the live job, `node infra/redpanda/register-schemas.mjs` (idempotent)
— one more line for #536 / a REQUEST — and `test/registry.test.ts`'s live block under `require-live-tests.mjs`
(`schema registry (live Redpanda, prefixed subjects, self-cleaning)`).
