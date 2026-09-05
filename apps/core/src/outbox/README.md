# outbox — `withEvents(tx, events[])`

Owner: window 1 (core) for the helper; the relay that reads `outbox` and publishes to Redpanda is window 14 (Phase
4, `apps/core/src/outbox/**` is theirs then — this helper stays the producers' write path). Table:
`packages/events/migrations/0100_outbox.sql`. Schemas: `packages/events/schemas/<topic>/v<N>.json`.

## Purpose

Makes the transactional outbox a structural guarantee instead of a convention. Every state change in apps/core
that has a domain event builds its envelope with `buildEvent` and hands it to `withEvents` **inside the same
transaction** as its row changes. Nothing in this app publishes to the bus directly, and nothing outside this
folder writes to `outbox` (ESLint rule + `test/guards.test.ts`).

## Public API (`src/outbox/index.ts`)

```ts
import { buildEvent, eventActor, withEvents } from '../../outbox';

await client.transaction(async (tx) => {
  // 1. state change(s) 2. audit_log 3. events — all on `tx`
  await withEvents(tx, [
    await buildEvent({
      topic: 'store.created',
      organizationId,
      storeId,
      aggregateType: 'store',
      aggregateId: storeId,
      actor: eventActor(actor),
      payload: {/* typed: LatestPayloads['store.created'] */},
    }),
  ]);
});
```

- `buildEvent(input)` → envelope for the latest version of `topic` (`makeEvent` from `@platform/events`;
  `event_id` uuid, `occurred_at` now, `actor` default `system`). `payload` is typed per topic.
- `withEvents(tx, events)` → validates **every** envelope (envelope + payload JSON Schema, `createValidator()`
  from `@platform/events`, one instance per process) before inserting any row, then inserts them through
  `toOutboxRow`. `published_at` stays `NULL` for the relay; `seq` orders them.
- `InvalidEventError` (`topic`, `errors[]`) — thrown for a failing envelope; message
  `invalid event <topic>: <path> <problem>; …`.
- `eventActor(actor)` — maps our audit `Actor` to the envelope `actor`.

## Guarantees (tested in `outbox.test.ts`)

1. **Same transaction.** A mutation that throws _after_ `withEvents` leaves no outbox row and no state change.
2. **Validation before write.** An envelope failing its schema aborts the whole transaction with a clear error;
   nothing of that transaction is committed.
3. **Ordering.** Creating a product then publishing it yields exactly `product.updated` then `product.published`
   (`store_id` set, `version = 1`, `published_at IS NULL`).
4. **Single writer.** `INSERT INTO outbox` outside `src/outbox/**` fails `pnpm --filter @platform/core lint`
   (`no-restricted-syntax` in `apps/core/eslint.config.mjs`) and `test/guards.test.ts`.

## How to test

`pnpm --filter @platform/core test -- src/outbox` — throwaway database via `createTestDatabase()`, fixtures through
the registry and catalog modules, everything as `platform_app`.
