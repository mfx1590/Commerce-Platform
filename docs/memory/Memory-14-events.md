# Memory 14 — Event bus & outbox relay
Window: 14 · Key: `events` · Branch prefix: `events/` · Model: strongest
Last updated: 2026-10-20 (window 14, session 1) · Contracts: contracts-v0.4.26 · Last commit: 992abc1 (code, #530) · Status: #530 PR #535 up (plan approved by the manager, addition (a) in 992abc1, addition (b) = REQUEST #536 filed), waiting for checks + review; #531 next (no push until #535 is merged)

## Identity (does not change)
Owned paths (write):
- `apps/core/src/outbox/**`
- `infra/redpanda/**`
- `packages/events/** (exception this phase only)`
Reads:
- everything
Never touches:
- consumers

## Mission — Phase 4 (Events, accounting, CRM)
Redpanda config, outbox relay with idempotent delivery, schema registry, replay CLI, consumer SDK with dead-letter pattern. Replay 10k historical orders in tests. No other Phase 4 window starts before events-v1 is tagged.

## Done
- #530 14.1 Redpanda topics + local/CI config — PR #535 (code commits 2a7510e + 992abc1 (the live block deletes its topics in a try/finally and prints them, manager addition a); head = this memory commit). REQUEST #536 = the exact CI diff for a broker in the auth-e2e job (manager addition b; the manager lands it on main before #531 merges). events 0.4.0: `planTopics`/`ensureTopics`/`createKafka`/`partitionKey`/`dlqTopicName`; infra/redpanda (create-topics.mjs, topics.policy.json, README). 34/34 events tests, three consecutive green local runs; local broker now carries the 38 real topics (1 partition each). Follow-up REQUEST to file after the merge: CI broker in the auth-e2e job (see infra/redpanda/README.md "What CI needs").

## In progress
- (nothing — #531 starts after #535 merges; the design below stays as the record of #530's plan)
- #530 14.1 Redpanda topics + local/CI config — PLAN as sent to the manager 2026-10-20 (built as planned, one change: partitions 1 locally/CI instead of 3, see Gotchas):
  - Client: kafkajs 2.2.4 — pure JS; Node is 20 here and in CI, which rules out @platformatic/kafka (needs Node 22.22+); @confluentinc/kafka-javascript is native librdkafka (Windows build risk). Kept behind packages/events' public API so a later swap touches one package.
  - Layout: topic plan + idempotent ensure logic in `packages/events/src/topics.ts` (public API, tests in packages/events/test); `infra/redpanda/create-topics.mjs` is the entrypoint (imports the built package by relative path — infra/redpanda is not a workspace package, same as infra/keycloak/reimport.mjs); `infra/redpanda/topics.policy.json` holds the numbers; also `pnpm --filter @platform/events topics:create`.
  - Topic list derived from EVENT_TOPICS, names verbatim (`order.placed`). A test fails when a schema directory has no retention class, and on a Kafka dot/underscore metric-name collision.
  - Partition key = store_id; org-scope events (store_id null) keyed by organization_id: ordered among themselves per organization, not relative to any store's stream (documented).
  - Partitions 3 per topic local/CI (single node, RF 1); production numbers in the policy file. The script never lowers a count; raises only via createPartitions when the policy says so.
  - Retention per ADR 0003: forever (retention.ms = -1) for order.*, payment.*, refund.*, shipment.*, return.*, stock.*, stock_item.*; 30 days for the rest. The outbox stays the replay source of truth (#534).
  - DLQ convention: `dlq.<groupId>`, cleanup.policy = compact, key = outbox id (latest failure per event wins; a successful replay writes a tombstone). The script creates DLQs for the groups in the policy file (empty today); the consumer SDK (#533) creates its own group's DLQ with the same helper.
  - Idempotency: createTopics skips existing; describeConfigs then alterConfigs only on drift; second run reports created 0 / altered 0.
  - Tests: pure unit tests + a live block `describe.runIf(brokerUp)` against 127.0.0.1:19092 with a random prefix (`t-<rand>.order.placed`) so it never deletes the shared broker's real topics; prints the reason and skips when the broker is down.
  - Loopback: KAFKA_BROKERS from env, default 127.0.0.1:19092; the compose broker advertises localhost:19092, so a kafkajs socketFactory maps localhost → 127.0.0.1 (Docker IPv6 loopback gotcha).
  - CI: the unit job has no broker (live block skips with a reason). After the PR: a REQUEST to add redpanda to the auth-e2e compose boot + run the events live block under require-live-tests.mjs.
  - packages/events 0.3.6 → 0.4.0 (new public API + dependency); README, CHANGELOG, infra/redpanda/README.md. The issue refines ADR 0003 item 2 (key = store_id, outbox id as a header, not key = event_id) — said in the PR body for the manager to mirror in docs.

## Next — Phase 4
- [x] #530 14.1 Redpanda topics + local/CI config (PR #535)
- [ ] #531 14.2 Outbox relay with idempotent delivery — notes for the start: read `apps/core/src/outbox/with-events.ts` + README (the only outbox writer), `app.outbox_lag()` in packages/db 0110, the three claim tables (0180/0195/0199, never touched); relay = organization-scoped client per organization, rows `WHERE published_at IS NULL ORDER BY seq`, key `partitionKey(row)`, headers `outbox_id`/`event_id`, `version`, `topic`; producer `acks: -1`, `idempotent: true`, `allowAutoTopicCreation: false` (dev-container auto-creates 1-partition/7-day topics otherwise), `createPartitioner: Partitioners.DefaultPartitioner` (kafkajs 2.x warns without it); mark published after the ack; crash-between-publish-and-mark test = republish, consumer dedupes by `outbox_id`; metric/log line per batch (count, lag, failures) without PII.
- [ ] #532 14.3 Schema registry + versioning
- [ ] #533 14.4 Consumer SDK + dead-letter queue
- [ ] #534 14.5 Replay CLI + 10k replay test (then the manager tags events-v1)

## Decisions made (with reasons)
- 2026-10-20 (manager): the core's in-process outbox consumers (notification_delivery 0180, customer_export 0195, customer_erasure_claim 0199) stay as they are in Phase 4; the relay publishes every outbox row to the bus IN ADDITION and never touches their claim tables. Moving them onto the bus is a later decision.

## Blocked / waiting
- (none)

## Gotchas learned
- **Dev-container partition budget (2026-10-20):** the compose Redpanda (`--memory=512M`, `topic_memory_per_partition` 4 MiB) refuses topic creation beyond ~128 partitions in total with `Number of partitions is invalid` (INVALID_PARTITIONS), and reclaims deleted partitions asynchronously, so a create right after a delete can be refused for a moment. Hence 1 partition per topic locally/CI (38 of the budget), tests use small prefixed subsets, and `ensureTopics` retries refused topics (6 × backoff). Any later window that needs more partitions locally asks window 5 for a compose memory change, never changes the broker config at runtime.
- `--mode=dev-container` sets `auto_create_topics_enabled=true`: naming a topic before `topics:create` ran gives a 1-partition/7-day default topic; the relay must set `allowAutoTopicCreation: false` and refuse to start on a missing topic.
- kafkajs under NodeNext ESM: named imports work for `Kafka`, `logLevel`, `Partitioners`; `ConfigResourceTypes` and the error classes only come through the default import (`import kafkajs from 'kafkajs'`).
- `node -e "…"` in the Bash tool with double quotes: backticks inside become command substitutions and silently eat text (mangled my memory file once). Use the Write/Edit tools or single-quoted heredocs for anything with backticks.
- The schema registry creates its `_schemas` topic on the first `GET /subjects`; it counts against the partition budget (1).

## How to run & test this package
- Setup done 2026-10-20: `pnpm install --frozen-lockfile`, `pnpm --filter "./packages/*" --filter @platform/cms build`, `pnpm --filter @platform/auth-sdk fga:seed` (store reused, model written to .env). Worktree .env DATABASE_URL* pinned to 127.0.0.1.
- Local Redpanda (compose stack, no docker commands from this window): Kafka 127.0.0.1:19092, schema registry 18081, HTTP proxy 18082, admin 9644 (`curl 127.0.0.1:9644/v1/cluster/health_overview`). Clean on 2026-10-20: no topics, no registry subjects.
- Manager session: "Manager session seven handover" (local_484d7727-b945-48ba-bb27-0366bd2bbdcc).
