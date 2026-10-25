# @platform/events

Versioned event schemas, generated types, validator, the outbox migration, and (since 0.4.0) the Redpanda topic plan. Owner: main window; window 14 writes here during Phase 4.
See [CLAUDE.md](./CLAUDE.md) for the public API and producer/consumer rules; ADR 0003 for the outbox pattern.

## Layout

```
schemas/common/v1.json        shared $defs (uuid, timestamp, currency, country, minor, sha256)
schemas/envelope/v1.json      the message envelope; payload validated per topic/version
schemas/<topic>/v<N>.json     one file per event version, additionalProperties: false
migrations/0100_outbox.sql    outbox table + RLS, applied by packages/db
scripts/generate.mjs          -> src/generated/{schemas,types}.ts
```

## Topics (38; all v1, `stock.moved` and `customer.export_requested` also v2)

| Aggregate      | Topics                                                                                                                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| store          | `store.created`, `store.updated`                                                                                                                                                         |
| product        | `product.published`, `product.updated`, `product.archived`                                                                                                                               |
| customer       | `customer.created`, `customer.updated`, `customer.erased`, `customer.export_requested` (0.3.2, ids only; v2 since 0.3.5: `requested_by_type`), `customer.export_ready` (0.3.6, ids only) |
| order          | `order.placed`, `order.confirmed`, `order.cancelled`, `order.completed`, `order.updated` (0.3.4: voided)                                                                                 |
| payment        | `payment.authorized`, `payment.captured`, `payment.failed`                                                                                                                               |
| refund         | `refund.issued`, `refund.failed`                                                                                                                                                         |
| shipment       | `shipment.created`, `shipment.label_created` (0.3.1), `shipment.shipped`, `shipment.delivered`                                                                                           |
| shipment       | `fulfillment.requested`, `fulfillment.picking`, `fulfillment.packed` (0.3.0)                                                                                                             |
| return         | `return.requested`, `return.received`                                                                                                                                                    |
| stock_movement | `stock.moved` (v2 since 0.3.3: keyed by the stock item; v1 frozen)                                                                                                                       |
| stock_item     | `stock_item.mapped` (0.3.3, ids only)                                                                                                                                                    |
| campaign       | `campaign.launched`, `campaign.ended` (0.2.0)                                                                                                                                            |
| feed           | `feed.published` (0.2.0)                                                                                                                                                                 |
| attribution    | `attribution.recorded` (0.2.0, one per touch, emitted by the core at placement)                                                                                                          |
| referral       | `referral.converted` (0.2.0)                                                                                                                                                             |
| review         | `review.published` (0.2.0)                                                                                                                                                               |
| cart           | `cart.abandoned` (0.2.0, emitted by the core's abandoned-cart job)                                                                                                                       |

## Producing an event (apps/core)

```ts
import { makeEvent, toOutboxRow, createValidator } from '@platform/events';

const validator = createValidator(); // once per process
await tenant.transaction(async (tx) => {
  // ...state change...
  const event = makeEvent({
    topic: 'order.placed',
    organizationId,
    storeId,
    aggregateType: 'order',
    aggregateId: order.id,
    payload,
  });
  const check = validator.validateEnvelope(event);
  if (!check.ok) throw new Error(check.errors.join('; '));
  const r = toOutboxRow(event);
  await tx.query(
    `INSERT INTO outbox (id, organization_id, store_id, topic, version, aggregate_type, aggregate_id, payload, headers, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      r.id,
      r.organization_id,
      r.store_id,
      r.topic,
      r.version,
      r.aggregate_type,
      r.aggregate_id,
      r.payload,
      r.headers,
      r.occurred_at,
    ],
  );
});
```

## Evolving a schema

1. Copy `schemas/<topic>/v1.json` to `v2.json`, change it, bump `$id` and `title`.
2. `pnpm --filter @platform/events generate && pnpm --filter @platform/events test`.
3. Bump the package version, add a CHANGELOG line, tag `events-vX.Y` at integration time.
   Consumers keep handling v1 until the Integrator retires it.

One exception so far (0.3.4, #466): an additive enum value on `order.updated` v1, whose every producer and reader is
inside apps/core, was widened in place. Once a consumer outside the core exists, such a widening is a v2.

## Redpanda topics (0.4.0, #530)

One topic per entry of `EVENT_TOPICS`, named verbatim, partitioned by `store_id` (organization-scope events by
`organization_id`), plus one compacted dead-letter topic per consumer group (`dlq.<groupId>`). The numbers live in
`infra/redpanda/topics.policy.json`; every choice is explained in `infra/redpanda/README.md`.

```ts
import { createKafka, ensureTopics, planTopics } from '@platform/events';

const plan = planTopics(policy, { environment: 'local' }); // throws if a schema has no retention class
const admin = createKafka().admin(); // KAFKA_BROKERS or 127.0.0.1:19092
await admin.connect();
const r = await ensureTopics(admin, plan); // created / altered / partitionsRaised / unchanged / warnings
```

`pnpm --filter @platform/events topics:create [-- --env ci --dry-run]` runs it from the command line. A second run
changes nothing. `test/topics.test.ts` checks the policy covers every schema and, when the local broker is up, that
the ensure step is idempotent (under a random prefix, self-cleaning).

## On the bus (0.4.1, #531)

One wire format for everybody (`src/relay-message.ts`): key = `store_id` (organization-scope events:
`organization_id`), value = the envelope JSON, headers `outbox_id` (= `event_id`; the idempotency key consumers
dedupe on), `topic`, `version`, `organization_id`, `store_id`, `occurred_at`, `producer`.

```ts
import {
  createKafka,
  createKafkaPublisher,
  decodeMessage,
  envelopeToMessage,
  outboxRowToEnvelope,
} from '@platform/events';

const publisher = createKafkaPublisher(createKafka()); // acks all, one request in flight, no auto-create
await publisher.connect();
await publisher.send('order.placed', [
  envelopeToMessage(outboxRowToEnvelope(row), 'core-outbox-relay/1'),
]);

// a consumer
const { envelope, outboxId } = decodeMessage({
  key: message.key,
  value: message.value,
  headers: message.headers,
});
```

The relay itself lives in `apps/core/src/outbox/relay.ts` (it reads the outbox; this package never touches a database).

## Schema registry and the published lock (0.5.0, #532)

- **Subjects:** one per (topic, version), `<topic>-v<N>-value`, compatibility **BACKWARD** on each. BACKWARD therefore
  means _a published version only evolves compatibly_; a new version is a new file and a new subject, free to
  break — consumers handle both (ADR 0003). The registered schema is the file with the common `$defs` inlined
  (the registry's JSON checker rejects `$ref`). `pnpm --filter @platform/events schemas:register` registers
  everything idempotently (`SCHEMA_REGISTRY_URL`, default `http://127.0.0.1:18081`).
- **The lock, `schemas/published.lock.json`:** the canonical inlined form of every published version. The test
  suite compares every schema file with it, offline: a published version that changed incompatibly fails with the
  rule named (`REQUIRED_ADDED at #/required: note`), a compatible change fails until it is accepted explicitly
  with `pnpm --filter @platform/events schemas:lock`, a new version or topic is published the same way.
  `schemas:lock` refuses a breaking change or a removed version. The lock is a reviewed artifact, not a
  tamper-proof one: a hand edit that changes a schema file together with its lock entry and sha256 passes the test,
  so a PR that changes an EXISTING key in `published.lock.json` is a manual review flag (manager rule, #545); a
  test checks every entry's sha256 against its own schema, which catches a sloppy edit, not a consistent one.
- **Our checker is the gate, the registry the second opinion:** Redpanda 24.2 catches a removed property, a type
  change and a narrowed enum, but accepts an added required property; `backwardIncompatibilities` catches all of
  them. A live test pins the registry's verdicts.
- **On the wire:** the relay stamps `schema_id` (the registry id of `topic@version`) next to `version`;
  `decodeMessage` exposes it.

## Evolving a schema (updated for 0.5.0)

1. Additive and backward-compatible (an optional field, a wider enum)? You MAY edit `v<N>.json` in place —
   then `pnpm --filter @platform/events schemas:lock` to accept it (the test tells you so), bump the package version.
2. Anything else (a required field, a removed or renamed field, a narrower type or enum)? Copy `v<N>.json` to
   `v<N+1>.json`, change it, bump `$id` and `title`; `schemas:lock` publishes the new version. The old file never changes.
3. `pnpm --filter @platform/events generate && pnpm --filter @platform/events test`, CHANGELOG line, tag `events-vX.Y` at integration time.

Why a lock and not a git comparison: CI's checkout is shallow, so a test that read the schema from `origin/main`
would have to fetch it, and on `main` itself would have to pick the merge commit's parent. The committed lock is the
baseline on every checkout, needs no git, and a missing or unreadable lock fails the test instead of skipping it.

## Consuming (0.6.0, #533)

```ts
import { createConsumer, createPgProcessedStore, replayFromDlq } from '@platform/events';

const consumer = createConsumer({
  groupId: 'accounting',
  topics: ['order.placed', 'payment.captured', 'refund.issued'],
  processed: createPgProcessedStore(db, 'accounting_processed'), // your table: group_id, outbox_id, unique pair
  handler: async ({ envelope, outboxId }, ctx) => {
    await db.transaction(async (tx) => {
      /* your side effects on tx; throw to retry */
      await ctx.markProcessed(tx); // the processed row commits WITH them: once per group for this transaction
    });
  },
});
await consumer.start(); // ensures dlq.accounting, subscribes, runs; SIGTERM → consumer.stop()

// later, for the entries that failed after every retry
await replayFromDlq({ groupId: 'accounting', handler, processed });
```

Guarantees: at-least-once from the bus; with a durable processed store a redelivery after a crash is a
no-op, and the side effects you commit in the same transaction as `ctx.markProcessed(tx)` happen once per
group — anything else (the memory store, a mark after the handler, side effects outside that transaction) is
at-least-once; a poison message never blocks the partition (it goes to
`dlq.<groupId>` with the error class and no payload, the offset is committed, the next message continues);
an unknown topic or a newer version is skipped and logged, never a crash. Choose the processed store by the
side effect: durable (your own table) with `ctx.markProcessed(tx)` inside your transaction for emails, ledger
entries, anything that must not repeat (the mark and the side effects commit together); the memory store, or
none, when the handler is idempotent anyway — those are at-least-once only, because a crash between the
handler and the mark reruns the handler. Replay from the DLQ reports an entry whose original message is gone
(a 30-day topic past its retention) as `missing` and keeps the entry; it never tombstones what it did not
handle. Group timeouts: session 10 s, heartbeat 3 s (sent between retry attempts), rebalance 60 s.

## Consumer groups (#561) and stopping (0.6.3)

The groups on main, listed in `infra/redpanda/topics.policy.json` so their dead-letter topics exist with the
environment's numbers before the first start: `accounting.ledger` (apps/accounting `LEDGER_GROUP`),
`engagement.ops`, `engagement.cdp`, `engagement.crm` (apps/engagement `OPS_GROUP_ID`, `CDP_GROUP_ID`,
`CRM_GROUP_ID`). A new group belongs in that list in the PR that adds it.

`consumer.stop()` stops reading, lets the batch in flight finish and then disconnects the producer. A message that is
mid-retry when you stop gives up at its next attempt: it is not dead-lettered and its offset is not committed, so
the next start of the group gets it again (`ConsumerStoppedError` never leaves the SDK; the log line is
`stopped_mid_message`).
