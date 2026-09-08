# @platform/events

Versioned event schemas, generated types, validator, and the outbox migration. Owner: main window.
See [CLAUDE.md](./CLAUDE.md) for the public API and producer/consumer rules; ADR 0003 for the outbox pattern.

## Layout

```
schemas/common/v1.json        shared $defs (uuid, timestamp, currency, country, minor, sha256)
schemas/envelope/v1.json      the message envelope; payload validated per topic/version
schemas/<topic>/v<N>.json     one file per event version, additionalProperties: false
migrations/0100_outbox.sql    outbox table + RLS, applied by packages/db
scripts/generate.mjs          -> src/generated/{schemas,types}.ts
```

## Topics (31, all v1)

| Aggregate      | Topics                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------- |
| store          | `store.created`, `store.updated`                                                         |
| product        | `product.published`, `product.updated`, `product.archived`                               |
| customer       | `customer.created`, `customer.updated`, `customer.erased`                                |
| order          | `order.placed`, `order.confirmed`, `order.cancelled`, `order.completed`, `order.updated` |
| payment        | `payment.authorized`, `payment.captured`, `payment.failed`                               |
| refund         | `refund.issued`, `refund.failed`                                                         |
| shipment       | `shipment.created`, `shipment.shipped`, `shipment.delivered`                             |
| return         | `return.requested`, `return.received`                                                    |
| stock_movement | `stock.moved`                                                                            |
| campaign       | `campaign.launched`, `campaign.ended` (0.2.0)                                            |
| feed           | `feed.published` (0.2.0)                                                                 |
| attribution    | `attribution.recorded` (0.2.0, one per touch, emitted by the core at placement)          |
| referral       | `referral.converted` (0.2.0)                                                             |
| review         | `review.published` (0.2.0)                                                               |
| cart           | `cart.abandoned` (0.2.0, emitted by the core's abandoned-cart job)                       |

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
