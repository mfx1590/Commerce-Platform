# Changelog — @platform/events

## 0.1.0 — 2026-09-04

- Scaffold created by the main window (Phase 0).

## 0.1.0 — 2026-09-04 (Phase 0 step 5)

- 24 event schemas v1 (JSON Schema 2020-12) + common $defs + envelope; `additionalProperties: false` everywhere; no PII fields.
- `scripts/generate.mjs` → `src/generated/{schemas,types}.ts` (json-schema-to-typescript); committed.
- `createValidator`, `makeEvent`, `toOutboxRow`; `migrations/0100_outbox.sql` (outbox table + RLS, applied by packages/db).

## 0.2.0 — 2026-09-08 (Integration 1, marketing)

- Seven new v1 topics (31 total): `campaign.launched`, `campaign.ended`, `feed.published`, `attribution.recorded`, `referral.converted`, `review.published`, `cart.abandoned` (docs/marketing-scope.md). Payloads carry ids, enums, minor amounts and hashes only: no review text, `code_hash` instead of the referral code, `email_hash` instead of the email, `referrer` is an origin.
- Decided at Integration 1: attribution is its own event (`attribution.recorded`, one per touch, same transaction as `order.placed`); `order.placed` stays at v1.
- Envelope v1: `topic` and `aggregate_type` enums extended (additive) with the new topics and `campaign`, `feed`, `attribution`, `referral`, `review`, `cart`. Existing envelopes keep validating; an envelope v2 would have forced every consumer to migrate for an enum widening.

## 0.3.0 — 2026-09-19 (CONTRACT CHANGE #225, fulfillment lifecycle; contracts-v0.4.3)

- Three additive v1 schemas: `fulfillment.requested` (a warehouse or 3PL accepted the fulfilment; carries provider + external_id), `fulfillment.picking` (picking started), `fulfillment.packed` (ready for the carrier; optional parcel_count). All carry ids, quantities and a timestamp only — no address, no name, no email. Envelope topic enum gains the three topics (34 total, was 31).
- Producer: window 8 (fulfillment module, task 2.5). Consumers: windows 4 (admin fulfillment screens), 11 (warehouse, Phase 3), 15 (accounting reads shipment.shipped as before — fulfillment.* are workflow signals, not money).

## 0.3.1 — 2026-10-06 (CONTRACT CHANGE #354, Integration 2a; contracts-v0.4.11)

- One additive v1 schema: `shipment.label_created` — a carrier label was bought for a packed shipment (`buyShipmentLabel`, Admin API 0.4.9). Payload: `shipment_id`, `order_id`, `store_id`, `carrier`, `tracking_number`, `label_url`, `created_at`; ids, the tracking number and the label URL only — no address, no name. Envelope topic enum gains it (35 topics, was 34). `payment.captured`, `order.confirmed` and `order.completed` already exist at v1 and are unchanged.
- Producer: the core's shipping module (in the same transaction as the move to `label_created`). Consumers: admin fulfillment screens; nobody is required to handle it (unknown-topic rule).

## 0.3.2 — 2026-10-08 (CONTRACT CHANGE #425, for core 3.2 #414; contracts-v0.4.14)

- One additive v1 schema: `customer.export_requested` — a GDPR data export was requested for one customer of one store
  (Admin API `exportCustomer`, 202). Payload is ids only: `customer_id`, `requested_by` (staff_user id), `requested_at`;
  `additionalProperties: false`, so no personal data can ever ride on it.
- Producer: the core's customers module, one row per request in the same transaction as the 202 (no dedupe — every request
  is a new request). Consumer: the GDPR export delivery (Integration 2b: storage + email); nobody is required to handle it
  (unknown-topic rule). 36 topics in v1.

## 0.3.3 — 2026-10-12 (CONTRACT CHANGE #453, stock pool step 2; contracts-v0.4.15)

- `stock.moved` **v2** (the first second version of a topic): stock is held per stock item and warehouse (db 0.3.5,
  migration 0191), so the payload requires `stock_item_id` and `sku` is the stock item's. `variant_id` and `store_id`
  are optional and come together (`dependentRequired`): present when a store caused the movement (a sale, a return, a
  shipment release), both absent for a pool movement no store caused (receipt, transfer, cycle count), whose envelope
  `store_id` is null. v1 is frozen and unchanged; `LATEST_VERSION['stock.moved']` is 2, so `makeEvent` writes v2.
- One additive v1 schema: `stock_item.mapped` — a store's variant was mapped to a stock item (Admin API
  `mapVariantToStockItem`, 0.4.13). Payload is ids only: `stock_item_id`, `previous_stock_item_id`, `variant_id`,
  `store_id`; `additionalProperties: false`. Envelope `store_id` is the variant's store, `aggregate_id` the item the
  variant is mapped to now.
- Envelope v1 (additive, as in 0.2.0): topic enum gains `stock_item.mapped` (37 topics, was 36), `aggregate_type` gains
  `stock_item`.
- Producer: the core's inventory module (window 1, #456), each in the same transaction as the state change. Consumers
  of `stock.moved` (search/availability, accounting, warehouse) must handle v2 from this release on and key by
  `stock_item_id`; `stock_item.mapped` is optional for everyone (unknown-topic rule).

## 0.3.4 — 2026-10-15 (CONTRACT CHANGE #466, Order.payment_status `voided`; contracts-v0.4.17)

- `order.updated` v1: the `payment_status` enum gains `voided` (authorized → voided when `cancelOrder` releases the
  authorization; terminal). Additive enum value in v1, widened in place and not a v2 (manager decision on #466): every
  producer and reader is inside apps/core; no consumer before Phase 4. If a consumer exists by the next such widening,
  that one is a v2. `order.cancelled` v1 is unchanged; 37 topics, unchanged.
- Producer: the core's orders module (window 1, a later PR): its own `order.updated` with
  `changed_fields: ['payment_status']`, in the same transaction as the void, before the status moves to `cancelled`.

## 0.3.5 — 2026-10-18 (CONTRACT CHANGE #482, customer self-service; contracts-v0.4.20)

- `customer.export_requested` v2: adds the required `requested_by_type` (`staff` | `customer`, closed enum);
  `requested_by` is the staff_user id or the customer id accordingly (the Store API `requestMyExport` has no staff
  id). Ids only, `additionalProperties: false`. v1 stays registered and frozen; `makeEvent` writes v2;
  `LATEST_VERSION['customer.export_requested']` is 2. 37 topics, unchanged.
- Producers: the core's customers module (window 13) — the admin `exportCustomer` path with
  `requested_by_type: staff`, `requestMyExport` with `customer`. No consumer yet (13.3 / #472 is the first and reads
  v2).

## 0.3.6 — 2026-10-18 (CONTRACT CHANGE #498, customer export delivery; contracts-v0.4.23)

- One additive v1 schema: `customer.export_ready` — a GDPR export bundle is built and downloadable (Store API
  `getMyExport`, Admin API `getCustomerExport`) until `expires_at`. Payload is ids and timestamps only:
  `export_id`, `customer_id`, `requested_by`, `requested_by_type` (`staff` | `customer`, closed enum), `expires_at`;
  `additionalProperties: false` — never the bundle, never personal data. `aggregate_type` `customer`,
  `aggregate_id` the customer id (as `customer.export_requested`). `LATEST_VERSION['customer.export_ready']` is 1.
- Envelope v1 (additive, as in 0.2.0): topic enum gains `customer.export_ready` next to
  `customer.export_requested` (38 topics, was 37).
- Producer: the core's customers module export job (window 13, #472), one event in the same transaction as the move
  to `ready` (none for `too_large` / `customer_gone`). Consumer: the notifications app (window 17) mails the
  customer, reading the address from the customer row at send time; nobody else is required to handle it
  (unknown-topic rule).

## 0.4.0 — 2026-10-20 (window 14, #530: Redpanda topics + local/CI config)

- New public API (`src/topics.ts`): `planTopics(policy, { environment, prefix, consumerGroups, topics })` derives one topic per `EVENT_TOPICS` entry (named verbatim) plus one compacted dead-letter topic per consumer group (`dlqTopicName(groupId)` → `dlq.<groupId>`), with partitions/replication per environment and `retention.ms` per class from `infra/redpanda/topics.policy.json`; it throws on a topic without a retention class, an unknown environment, an invalid name or a Kafka metric-name collision. `ensureTopics(admin, plan, { dryRun })` creates missing topics, alters only drifted managed configs, raises partition counts the policy raised, never deletes. `createKafka()` (kafkajs client, `KAFKA_BROKERS` or `127.0.0.1:19092`, `localhost` pinned to IPv4 by `ipv4LoopbackSocketFactory`), `brokersFromEnv`, `partitionKey` (store_id, or organization_id for organization-scope events), `retentionClassOf`, `metricName`, `RETENTION_MS`, `DEFAULT_BROKERS`.
- New dependency: `kafkajs` 2.2.4 (pure JS; Node 20). Kept behind this package's public API.
- New script: `pnpm --filter @platform/events topics:create` (builds, then runs `infra/redpanda/create-topics.mjs`).
- Tests: `test/topics.test.ts` — pure checks (every schema has exactly one retention class, ADR 0003 classes, plan/config derivation, DLQ naming, collisions, the key rule) and a live block against the local broker (`describe.runIf`, random prefix, self-cleaning; skipped with a printed reason when the broker is down).
- No schema change; envelope and payloads unchanged. Minor bump for the new public API and dependency.
- Local and CI topics have 1 partition: the compose broker (`--memory=512M`, 4 MiB reserved per partition) has a budget of about 128 partitions in total, measured on 2026-10-20; production has 12. `ensureTopics` retries topics the broker refuses with a retriable error (Redpanda's `INVALID_PARTITIONS` while it reclaims deleted partitions, timeouts, controller moves) up to 6 times and reports the retry as a warning.

## 0.4.1 — 2026-10-20 (window 14, #531: outbox relay — the wire format and the producer side)

- `src/relay-message.ts` (public): `outboxRowToEnvelope(row)` (the inverse of `toOutboxRow`), `envelopeToMessage(envelope, producer)` → `{ key, value, headers }` with key = `partitionKey` (store_id, organization_id for organization scope), value = the envelope JSON, headers `outbox_id` (the idempotency key every consumer dedupes on), `event_id`, `topic`, `version`, `organization_id`, `store_id` (absent when null), `occurred_at`, `producer`; `decodeMessage(raw)` for consumers (Buffers or strings; throws on a non-envelope value). One definition for the relay (apps/core), the consumer SDK (#533) and the replay (#534).
- `src/publisher.ts` (public): `MessagePublisher` (send / connect / disconnect) and `createKafkaPublisher(kafka, { retries, requestTimeoutMs })` — acks all, one request in flight (per-partition order survives retries), no auto topic creation, bounded retries (not kafkajs's idempotent producer: it insists on unbounded retries); `assertTopicsPresent(admin, topics)` for a relay's start-up check.
- `ensureTopics` takes the narrow `TopicAdmin` interface instead of kafkajs's `Admin` (#535 review); kafkajs's client satisfies it unchanged.
- `infra/redpanda/create-topics.mjs --env production` refuses to run without `--brokers` naming a non-loopback cluster (#535 review): it would otherwise raise the shared local topics to 12 partitions.
- No schema change.
- `createKafka` sets bounded client timeouts (`connectionTimeout` 3 s, `requestTimeout` 10 s, enforced client-side), overridable through `config`: a broker that accepts the connection and never answers fails the request instead of hanging the relay's pass (#531 review).

## 0.5.0 — 2026-10-20 (window 14, #532: schema registry + versioning)

- Registry client (`src/registry.ts`, plain fetch): `createRegistryClient({ url })` (register, lookup, checkCompatibility, get/setCompatibility, listSubjects, getById, deleteSubject, reachable), `subjectFor(topic, version)` = `<topic>-v<N>-value` — one subject per (topic, version) with BACKWARD on each, so BACKWARD means "a published version only evolves compatibly" while a new version is a new file and a new subject (our v2s are breaking against v1 by design: stock.moved v2 requires stock_item_id, customer.export_requested v2 requires requested_by_type). `registrySchemas()` (every schema with the common $defs inlined — Redpanda 24.2's JSON checker rejects `$ref`), `registerAllSchemas(client, { prefix, dryRun })`(idempotent; sets BACKWARD where unset; reports refused subjects),`resolveSchemaIds(client)`→`topic@version → id`; `SCHEMA_REGISTRY_URL`(default`http://127.0.0.1:18081`).
- Our own offline BACKWARD checker (`src/schema-compat.ts`): `backwardIncompatibilities(old, new)` names the rule and the path — required property added, property removed under a closed content model, type narrowed, enum/const narrowed or introduced, content model closed, bound tightened, pattern/format changed, alternative removed, items narrowed. It is the CI gate; the registry is the second opinion (measured: Redpanda 24.2 catches removals, type changes and enum narrowing but accepts an added required property — pinned by a live test).
- The published-schema lock `schemas/published.lock.json` (`src/schema-lock.ts`, `pnpm --filter @platform/events schemas:lock`): the canonical inlined form of every published version. `test/schema-compat.test.ts` fails CI when a published version changed — breaking: the rule is named and a new `v<N+1>.json` is required; compatible: an explicit `schemas:lock` (visible in the PR) is required; a new version/topic: `schemas:lock` publishes it. `schemas:lock` itself refuses a breaking change or a removed version. No registry needed in CI for this.
- Registration script: `infra/redpanda/register-schemas.mjs` (`pnpm --filter @platform/events schemas:register [-- --dry-run --url …]`), one JSON summary line; a second run registers nothing.
- Wire format: `envelopeToMessage(e, producer, { schemaId })` adds the `schema_id` header (`HEADER_SCHEMA_ID`); `decodeMessage` exposes `schemaId` (number or null). The relay stamps it (`relayOnce({ schemaIds })`; `relay-cli.ts` resolves the ids at start and refuses to start without the registry unless `--no-registry`).
- `inlineCommonRefs`, `canonicalJson`, `schemaDigest` (`src/schema-inline.ts`) are public. No schema change; the lock records the 40 versions as published today.

## 0.6.0 — 2026-10-21 (window 14, #533: consumer SDK + dead-letter queue)

- `createConsumer({ groupId, topics, handler, processed?, retries?, backoff?, dlq?, topicPrefix?, log?, fromBeginning? })` (`src/consumer.ts`, kafkajs behind the public API): decodes every message (`decodeMessage`), skips an unknown topic or a version this package does not know (logged, never a crash), dedupes on the `outbox_id` header through a `ProcessedStore`, runs the handler with bounded retries (default 5, backoff 200 ms → 3 s), and after the last failure writes a dead-letter record to `dlq.<groupId>` (compacted, kept forever, created with `ensureTopics` at start; key = outbox id; value = ids, offsets, attempts, the error CLASS, `failed_at` — never the payload). The offset is committed only after the handler succeeded or the record is in the DLQ (`autoCommit` off, one explicit commit per message). A message whose value does not decode is dead-lettered as `decode_failed`. One JSON line per event (`started`, `duplicate`, `retry`, `dead_lettered`, `skipped_unknown`, `crashed_before_commit`, `stopped`), counts and ids only. `fromBeginning` defaults to true: a new group rebuilds from history and a crash before the first commit loses nothing.
- Processed stores: `createMemoryProcessedStore(max)` (bounded; tests and idempotent handlers) and `createPgProcessedStore(db, table)` over a table the CONSUMER owns (`group_id`, `outbox_id`, unique pair; parameterised SQL, table name validated). The SDK never creates tables; a shared `consumer_processed` table in packages/db is a CONTRACT CHANGE when a consumer wants one. Documented which to choose: durable store for side effects that must not repeat (emails, ledger entries), memory store or none for idempotent handlers.
- `readDeadLetters(groupId)` (latest record per outbox id, tombstones drop the entry) and `replayFromDlq({ groupId, handler, only?, dryRun? })` (`src/dlq.ts`): re-fetches every original message by (topic, partition, offset) with a throwaway group that seeks, reruns the handler with the same retries, writes a tombstone on success and a fresh record (attempts added up) on failure.
- Tests (`test/consumer.test.ts`): stores (pure); live on the local broker with prefixed topics and groups, self-cleaning — a duplicate delivery runs the handler once, a poison message lands in the DLQ after N tries and the next messages continue, an unknown version is skipped, a crash before the commit redelivers and the processed store keeps it to once, replay-from-DLQ (dry run, success tombstones, persistent failure re-records).
- The three in-core outbox consumers are not migrated (manager decision on #530–#534).
- Review additions (manager, #533): **atomic dedupe** — `ctx.markProcessed(tx)` inside the handler marks the outbox id through the handler's own client (`ProcessedStore.markProcessedWith`, implemented by the Postgres store), so the side effects and the processed row commit together and the SDK skips its own mark afterwards; the memory store has no such seam and is at-least-once only (documented). **Missing originals** — `replayFromDlq` checks the partitions' watermarks first: an entry whose (topic, partition, offset) is below the low watermark (retention) or at/above the high watermark, or is not found before the read passed its offset, is reported in `missing` and its DLQ entry is kept, never tombstoned; the read stops as soon as every partition passed its highest wanted offset. **Heartbeat/timeouts** — `heartbeat()` between attempts; session 10 s, heartbeat 3 s, rebalance 60 s by default (`sessionTimeoutMs`, `heartbeatIntervalMs`, `rebalanceTimeoutMs`); the default retries (5 attempts, 200 ms → 3 s) wait ≈ 6 s in total, inside one session.
- #532 review follow-ups folded in (#545): the checker treats any keyword it does not understand as BREAKING when it appears or changes (`UNKNOWN_KEYWORD`, closed by default), understands `dependentRequired` (an added dependency or name is breaking) and `allOf` (pairwise recursion; an added conjunct is breaking); a test checks every lock entry's sha256 against its own schema and the README says the lock is a reviewed artifact, not a tamper-proof one (a PR that changes an existing lock key is a manual review flag); the relay's pass line gains `unstamped` (rows published without a `schema_id` although ids were given); `register-schemas.mjs --url` without a value is refused.
- Fix (Fable review of #546): `readDeadLetters` / `replayFromDlq` finished a partition only after Σ(high − low) messages, which a compacted topic (every DLQ) never reaches once compaction has removed records and tombstones — the read timed out forever after the first replay. A partition is now done when the consumed offset reaches `high − 1` (an empty one needs nothing); the count is an upper bound. `readTopicToEnd` is public with a `TopicReaderClient` slice so a fake client with offset gaps proves it (three unit tests).

## 0.6.1 — 2026-10-21 (window 14, #534: replay CLI + the 10k test)

- Consumer SDK: one offset commit per batch (after its last handled message; `resolveOffset` per message) instead of one per message — at-least-once unchanged, a redelivered partial batch is absorbed by the processed store, the crash seam still returns before the commit. `onBatch` diagnostics seam (topic, partition, first/last offset, size).
- The replay itself lives in `apps/core/src/outbox/replay.ts` (`pnpm --filter @platform/core outbox:replay`); it reuses `envelopeToMessage` with two extra headers, `replay` and `replayed_at`.
- #533 review nits folded in (#546): `processed.has()` is re-checked before every retry attempt (an id another instance marked meanwhile is a duplicate, not a retry); `ctx.markProcessed(tx)` on a store without `markProcessedWith` throws `ConsumerConfigurationError` out of the consumer and the replay (misconfiguration, never dead-lettered); the dead `UNINTERPRETED` set is gone; the README guarantee sentence says once per group only for the side effects committed with `ctx.markProcessed(tx)`; `register-schemas.mjs` validates its arguments before loading anything (a test spawns it with `--url` and no value); `readTopicToEnd` also finishes a partition that stays silent for `idleMs` after its last message (its last record may have been a tombstone compaction removed), with a test.

## 0.6.2 — 2026-10-23 (CONTRACT CHANGE #580, manager landing; for #576, window 16)

- `customer.erased` v2 (`schemas/customer.erased/v2.json`): v1 + required `email_hash` (the house `sha256` $def), so a consumer can suppress a profile keyed by the hash as well as by `customer_id` (the CDP tracks guests under `email_hash` since #576). The producer computes it inside the erasure transaction, BEFORE the row is deleted, from the e-mail as it was (never the tombstone). v1 stays frozen; `makeEvent` writes v2; consumers accept both. No new personal data on the bus: the same digest `customer.created` / `customer.updated` / `order.placed` already carry.
- Types regenerated (41 types across 38 topics); `published.lock.json` gains `customer.erased@2` via `schemas:lock`.
