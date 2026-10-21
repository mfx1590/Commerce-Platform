# @platform/events

## Purpose

The event contract: one versioned JSON Schema per domain event (`schemas/<topic>/v<N>.json`), the shared envelope,
generated TypeScript types, an Ajv validator, envelope helpers, and the `outbox` table migration (ADR 0003).
38 topics, every one with a v1: store.{created,updated}, product.{published,updated,archived}, customer.{created,updated,erased},
order.{placed,confirmed,cancelled,completed,updated}, payment.{authorized,captured,failed}, refund.{issued,failed},
shipment.{created,shipped,delivered}, return.{requested,received}, stock.moved, since 0.2.0 (marketing)
campaign.{launched,ended}, feed.published, attribution.recorded, referral.converted, review.published, cart.abandoned,
since 0.3.0 fulfillment.{requested,picking,packed}, since 0.3.1 shipment.label_created, since 0.3.2 customer.export_requested,
since 0.3.3 stock_item.mapped plus stock.moved v2 (keyed by the stock item; `makeEvent` writes v2, v1 stays frozen),
since 0.3.5 customer.export_requested v2 (`requested_by_type` staff | customer; v1 stays frozen),
and since 0.3.6 customer.export_ready (ids and `expires_at` only). Since 0.4.0 (#530) also the Redpanda topic plan
(`planTopics`, `ensureTopics`, `createKafka`; `src/topics.ts`) with the policy in infra/redpanda/topics.policy.json, and since
0.4.1 (#531) the wire format (`src/relay-message.ts`) and the producer side (`src/publisher.ts`) the relay, the consumer SDK and the replay share.

## Owner

main window only. Window 14 (events) gets a Phase-4 exception (docs/ownership.md). Everyone else: read-only;
changes via `CONTRACT CHANGE:` issue. Adding a field = new file `v<N+1>.json`, never edit a published version.

## Run / test

- `pnpm --filter @platform/events generate` — regenerates `src/generated/{schemas,types}.ts` (committed; CI checks they are current)
- `pnpm --filter @platform/events test` — Vitest: every schema compiles, sample envelopes validate, PII/float/extra-field guards
- `pnpm --filter @platform/events build | typecheck`
- `pnpm db:migrate` applies `migrations/0100_outbox.sql` together with packages/db migrations.
- `pnpm --filter @platform/events schemas:register [-- --dry-run]` — registers every schema in the registry idempotently (`infra/redpanda/register-schemas.mjs`; `SCHEMA_REGISTRY_URL`, default 127.0.0.1:18081); `schemas:lock` — accepts a compatible change or a new version into `schemas/published.lock.json` (refuses a breaking one). `test/schema-compat.test.ts` fails when a published version changed; `test/registry.test.ts` has a live block that skips with a printed reason when the registry is down.
- `pnpm --filter @platform/events topics:create [-- --env ci --dry-run]` — creates every topic on the broker idempotently (`infra/redpanda/create-topics.mjs`; `KAFKA_BROKERS`, default 127.0.0.1:19092). `test/topics.test.ts` has a live block that skips with a printed reason when the broker is down.

## Public API (`@platform/events`)

- `EVENT_TOPICS`, `LATEST_VERSION`, `EVENT_SCHEMAS`, `ENVELOPE_SCHEMA`, `COMMON_SCHEMA`
- Types: `EventEnvelope<'order.placed'>`, `OrderPlacedV1`, `PaymentCapturedV1`, … (`<PascalTopic>V<N>`), `EventPayloads`, `LatestPayloads`, `EventTopic`, `AggregateType`
- `createValidator()` → `{ validateEnvelope(event), validatePayload(topic, version, payload), ajv }`; one instance per process
- `makeEvent({ topic, organizationId, storeId, aggregateType, aggregateId, payload, actor?, trace? })` → envelope for the latest version
- `toOutboxRow(envelope)` → the column map for `INSERT INTO outbox`
- Topics (0.4.0): `planTopics(policy, opts)`, `ensureTopics(admin, plan, { dryRun })`, `createKafka(opts)`, `brokersFromEnv()`, `dlqTopicName(groupId)`, `partitionKey(envelope)`, `retentionClassOf(topic, policy)`, `RETENTION_MS`, `DEFAULT_BROKERS`; types `TopicPolicy`, `TopicSpec`, `EnsureResult`, `TopicAdmin` (the narrow admin slice `ensureTopics` takes)
- Registry (0.5.0): `createRegistryClient({ url })`, `subjectFor(topic, version)`, `registrySchemas()`, `registerAllSchemas(client, opts)`, `resolveSchemaIds(client)`, `schemaKey`; checker `backwardIncompatibilities(old, new)` / `isBackwardCompatible` / `formatIncompatibilities`; lock `currentLockEntries` / `compareWithLock` / `explainVerdict` / `buildLock`; `inlineCommonRefs` / `canonicalJson` / `schemaDigest`; `HEADER_SCHEMA_ID`
- Bus (0.4.1): `outboxRowToEnvelope(row)`, `envelopeToMessage(envelope, producer)` → `{ key, value, headers }`, `decodeMessage(raw)` → `{ envelope, outboxId, headers }`, `HEADER_*` names; `createKafkaPublisher(kafka, opts)` → `MessagePublisher` (send / connect / disconnect), `assertTopicsPresent(admin, topics)`

## Rules for producers and consumers

- Producers (apps/core) write the outbox row in the same transaction as the state change; never publish to the bus directly.
- Payloads carry ids, hashes, amounts, countries — never names, emails, addresses, or card data. `email_hash` = sha256(lowercased email).
- Money is integer minor units + ISO-4217 currency. Timestamps are RFC-3339 UTC.
- `event_id` (= the outbox id) is the idempotency key for every consumer and travels as a message header; the Kafka _partition_ key is `store_id` (or `organization_id` for organization-scope events) so per-store order is kept (#530, `partitionKey`). Envelope `version` selects the payload schema.
- Consumers accept unknown topics and higher versions gracefully (log and skip); they never crash on them.
- A PUBLISHED schema version changes only backward-compatibly, and only through `schemas:lock` (#532); anything breaking is a new `v<N+1>.json`. Registry subjects are per (topic, version), BACKWARD each.

## Constraints

- Import other packages only through their public API (`@platform/<name>`), never `src/*`.
- No secrets in code. No PII in logs.
- Update README.md and CHANGELOG.md with every change.
