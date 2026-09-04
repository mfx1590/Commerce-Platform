# ADR 0003 — Events: transactional outbox in the core, Redpanda bus, versioned JSON Schemas, consumers derive everything

Status: accepted (Phase 0, 2026-09-04) · Owner: main window (schemas), window 14 (relay) · Implemented in `packages/events`, `apps/core/src/outbox` (Phase 4)

## Context

Accounting, warehouse allocation, CRM, notifications and BI all need to know what happened in the core, exactly once
per fact, in order, replayable. Publishing to a broker from inside request handlers double-writes: a commit can
succeed while the publish fails (or the reverse), and the ledger never reconciles (plan risk #2).

## Decision

1. **Outbox table, same transaction.** Every state change on a starred entity (docs/domain.md) inserts a row in
   `outbox` inside the transaction that changes the state. If the transaction rolls back, so does the event.
   Producers never talk to the broker.
2. **One relay publishes.** A single process (window 14, Phase 4) reads `outbox WHERE published_at IS NULL ORDER BY
   seq`, publishes to Redpanda with key = `event_id`, then sets `published_at`. At-least-once; every consumer is
   idempotent on `event_id`.
3. **Redpanda (Kafka API).** Topics = event names (`order.placed`, …), partitioned by `store_id` so per-store order
   is preserved. Retention: forever for accounting-relevant topics (replayable), 30 days otherwise. Schema registry
   holds the same JSON Schemas as `packages/events`.
4. **Envelope + versioned payload.** Every message is `schemas/envelope/v1.json`: `event_id`, `topic`, `version`,
   `occurred_at`, `organization_id`, `store_id`, `aggregate_type`, `aggregate_id`, `actor`, `trace`, `payload`. The
   payload is validated against `schemas/<topic>/v<version>.json` before the outbox insert.
   `additionalProperties: false` everywhere: a new field is a new version.
5. **Events carry facts, not PII.** Ids, amounts in minor units, currency, country, `email_hash`. Consumers that need
   PII (notifications) look it up through the API with their own permission. `customer.erased` tells every consumer
   to delete its copies.
6. **Accounting derives from events only.** `ledger_entry` is written by the accounting service from
   `order.placed`, `order.cancelled`, `payment.captured`, `refund.issued`, `shipment.shipped` (each carries
   `legal_entity_id`). No UI action writes the ledger.
7. **Phase discipline.** Phases 1–3: the core writes the outbox; nothing consumes it (the table is the audit trail).
   Phase 4: window 14 builds the relay and schema registry alone, then consumers start. Schema changes are single-
   window (plan 6.6) and tagged `events-vX.Y`.

## Consequences

- Every module in `apps/core` imports `makeEvent`/`toOutboxRow`/`createValidator` from `@platform/events`; a module
  that mutates a starred entity without an outbox insert is a review BLOCK.
- `outbox` grows; the relay archives published rows older than 90 days to cold storage (Phase 6).
- Replaying for a new consumer = reset its consumer group; the bus, not the database, is the source for consumers.
- Ordering is per store, not global; consumers that need cross-store order (none today) sort by `occurred_at`.
- The seed of the ledger chart of accounts and the Odoo mapping live with window 15, keyed by `journal` and
  `legal_entity_id`.

## Alternatives rejected

- **Publish from the request handler**: double-write, unreconcilable.
- **CDC (Debezium) on business tables**: leaks schema details to consumers; harder to version; needs Kafka Connect.
- **Kafka (MSK/Confluent)**: fine later; Redpanda is simpler to run locally and managed (decision 5).
- **Avro**: good, but JSON Schema keeps one format across API, events and TypeScript generation.
