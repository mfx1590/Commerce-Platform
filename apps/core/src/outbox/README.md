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

## The relay — `relay.ts` (window 14, #531)

The ONE process that moves outbox rows onto the bus (ADR 0003 item 2). `relayOnce(client, publisher, opts)` is one
pass in one transaction on an **organization-scoped** client (never a raw pool):

1. `pg_advisory_xact_lock` on the organization — two relay instances never interleave one organization's rows.
2. `SELECT … FROM outbox WHERE published_at IS NULL ORDER BY seq LIMIT batch` (default 500).
3. Every row is rebuilt into its envelope (`outboxRowToEnvelope`) and re-validated; rows are grouped by topic in
   `seq` order and sent with one `publisher.send(topic, messages)` per topic. The message: key = `store_id`
   (`organization_id` for organization-scope rows), value = the envelope JSON, headers `outbox_id`, `event_id`,
   `topic`, `version`, `organization_id`, `store_id`, `occurred_at`, `producer` (`@platform/events`
   `envelopeToMessage`). The publisher (`createKafkaPublisher`) sends with acks = all and one request in flight, so
   per-partition order is the `seq` order even across retries.
4. Acknowledged rows: `published_at = now()`, `attempts + 1`, `last_error = NULL`. Rows of a topic whose send was
   not acknowledged: `attempts + 1`, `last_error = <error class>` (`KafkaJSNumberOfRetriesExceeded`,
   `KafkaJSProtocolError:NOT_LEADER_FOR_PARTITION`, … — never the message), `published_at` stays NULL and the next
   pass sends them again. Rows whose envelope no longer validates: `last_error = invalid_envelope`, never sent.
5. Commit, then one JSON line: `{ relay, organization_id, batch, published, failed, invalid, failed_topics,
duration_ms, lag_rows, lag_oldest_seconds }` (lag from `app.outbox_lag()`); counts, ids and seconds only.

**At-least-once, dedupe by `outbox_id`.** A crash after the send and before the commit rolls the pass back: the
rows are still unpublished and go out again with the same `outbox_id`. Every consumer dedupes on that header
(the consumer SDK, #533, does it for them). A broker outage leaves the rows unpublished and counted in
`attempts` — nothing is lost, nothing is skipped. The relay never deletes a row and never touches the in-process
consumers' claim tables (`notification_delivery`, `customer_export`, `customer_erasure_claim`): they read the
outbox by their own cursors, not by `published_at` (manager decision on #530–#534).

`runRelayLoop` runs passes back to back while a pass fills the batch, every `intervalMs` otherwise, until its
`AbortSignal` fires. `relay-cli.ts` is the process:

```bash
pnpm --filter @platform/core exec tsx src/outbox/relay-cli.ts [--once] [--batch 500] [--interval-ms 1000]
```

`DATABASE_URL_APP` (the app role), `CORE_ORGANIZATION_ID` (default: the seeded HQ, like every core job),
`KAFKA_BROKERS` (default `127.0.0.1:19092`). Before the first pass it lists the broker's topics and refuses to
start if any topic of `infra/redpanda/topics.policy.json` is missing (the dev container would auto-create one
with the wrong numbers; run `infra/redpanda/create-topics.mjs` first). SIGTERM / SIGINT stop it after the current
pass. The package scripts `outbox:relay` / `outbox:replay` are a REQUEST to window 1 (`apps/core/package.json`).

Tests: `relay.test.ts` — the database part always (throwaway database, app role, recording publisher: order,
keys, headers, marking, the crash seam, the outage, a partial pass, a second organization under RLS, the loop,
the CLI arguments); the bus part against the local Redpanda on a prefixed `store.updated` topic with 3
partitions (every row arrives, per store in `seq` order on one partition, organization scope keyed by the
organization, a republish after a crash reaches the bus twice with the same `outbox_id` and dedupes to once;
skipped with the reason when the broker is down, deletes its topic afterwards).

### Timeouts (a hung broker never holds the lock)

The pass transaction holds the advisory lock and the row set while the broker is awaited, so every wait is bounded
twice. Broker side: the kafkajs client has `connectionTimeout` 3 s and `requestTimeout` 10 s (enforced
client-side; a broker that accepts the connection and never answers fails the request), the producer retries 3
times, and the relay puts its own deadline on every send (`publishTimeoutMs`, default 15 s): a topic that is not
acknowledged in time counts as failed (`attempts + 1`, `last_error = RelayPublishTimeout`) and the pass completes.
Database side, the backstop: `SET LOCAL statement_timeout` (30 s) and `SET LOCAL idle_in_transaction_session_timeout`
(60 s) on the pass transaction, so a pass that outlives them is aborted by Postgres — nothing is marked, the
rows are still unpublished — and the loop logs `{ relay, state: "pass_failed", organization_id, error_class }`
and goes on after the interval. Tests: a send that never answers (cut off by the relay deadline, the loop goes
on), a publish that outlives the idle backstop (the pass is aborted, nothing marked, the next pass drains), a
pass that throws (logged by class, the loop continues), and kafkajs against a TCP server that accepts and never
answers (fails within the client timeouts).

One more thing the backstop needs: pg-pool keeps an error listener on idle clients only, so when Postgres ends
the session of a client that is checked out for a pass, the client's `error` event has no listener and the process
dies. `guardPoolClients(pool)` (called once by `relay-cli.ts` on the core's pool, and by the test on its own)
attaches one to every connection the pool opens: the drop is logged as `{ state: "connection_error", error_class }`
and the pass fails through its next statement, which the loop handles.
