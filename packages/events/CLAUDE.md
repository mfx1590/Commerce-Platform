# @platform/events

## Purpose

The event contract: one versioned JSON Schema per domain event (`schemas/<topic>/v<N>.json`), the shared envelope,
generated TypeScript types, an Ajv validator, envelope helpers, and the `outbox` table migration (ADR 0003).
24 topics in v1: store.{created,updated}, product.{published,updated,archived}, customer.{created,updated,erased},
order.{placed,confirmed,cancelled,completed,updated}, payment.{authorized,captured,failed}, refund.{issued,failed},
shipment.{created,shipped,delivered}, return.{requested,received}, stock.moved.

## Owner

main window only. Window 14 (events) gets a Phase-4 exception (docs/ownership.md). Everyone else: read-only;
changes via `CONTRACT CHANGE:` issue. Adding a field = new file `v<N+1>.json`, never edit a published version.

## Run / test

- `pnpm --filter @platform/events generate` — regenerates `src/generated/{schemas,types}.ts` (committed; CI checks they are current)
- `pnpm --filter @platform/events test` — Vitest: every schema compiles, sample envelopes validate, PII/float/extra-field guards
- `pnpm --filter @platform/events build | typecheck`
- `pnpm db:migrate` applies `migrations/0100_outbox.sql` together with packages/db migrations.

## Public API (`@platform/events`)

- `EVENT_TOPICS`, `LATEST_VERSION`, `EVENT_SCHEMAS`, `ENVELOPE_SCHEMA`, `COMMON_SCHEMA`
- Types: `EventEnvelope<'order.placed'>`, `OrderPlacedV1`, `PaymentCapturedV1`, … (`<PascalTopic>V<N>`), `EventPayloads`, `LatestPayloads`, `EventTopic`, `AggregateType`
- `createValidator()` → `{ validateEnvelope(event), validatePayload(topic, version, payload), ajv }`; one instance per process
- `makeEvent({ topic, organizationId, storeId, aggregateType, aggregateId, payload, actor?, trace? })` → envelope for the latest version
- `toOutboxRow(envelope)` → the column map for `INSERT INTO outbox`

## Rules for producers and consumers

- Producers (apps/core) write the outbox row in the same transaction as the state change; never publish to the bus directly.
- Payloads carry ids, hashes, amounts, countries — never names, emails, addresses, or card data. `email_hash` = sha256(lowercased email).
- Money is integer minor units + ISO-4217 currency. Timestamps are RFC-3339 UTC.
- `event_id` is the Kafka key and the idempotency key for every consumer. Envelope `version` selects the payload schema.
- Consumers accept unknown topics and higher versions gracefully (log and skip); they never crash on them.

## Constraints

- Import other packages only through their public API (`@platform/<name>`), never `src/*`.
- No secrets in code. No PII in logs.
- Update README.md and CHANGELOG.md with every change.
