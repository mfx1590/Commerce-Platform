# @platform/analytics-ingest

Every bus event into ClickHouse `raw_events`, exactly once in effect (#600; Phase 5 plan D1, D2, D12). Owner:
window 12 (data). The models on top of `raw_events` live in `data/clickhouse/` (#601).

## How it works

```
Redpanda (every topic of @platform/events, from the beginning)
  └─ group analytics.raw (override: ANALYTICS_GROUP_ID / --group)
       ├─ valid event ──► insert buffer ──(size or time flush)──► ClickHouse raw_events ─┐
       └─ undecodable / unknown topic or version / fails its schema ──► dlq.<group> ──────┤
                                                                                         ▼
                                       commit the partition offset only when BOTH are acknowledged
```

- **Exactly once in effect.** Offsets are committed only after ClickHouse acknowledged the insert (no async
  insert) and the dead letters are on `dlq.<group>` (acks = all). A crash in between redelivers the batch; its rows
  come in again with the same `(topic, event_id)` and `raw_events` (ReplacingMergeTree, version `ingested_at`)
  folds them. **Count with `FINAL`** (or `uniqExact(event_id)`) until a merge has run.
- **Nothing is dropped silently.** Unlike the SDK's `createConsumer`, which skips an unknown topic or a higher
  version (a ledger has nothing to post for it), the raw store dead-letters them, so a deploy that knows the new
  version can replay them (`replayFromDlq`). Dead letters have the SDK's `DeadLetter` shape: ids, offsets and the
  error class (`UnknownEventError`, `InvalidEventError`, `UndecodableMessageError`). Never the payload.
- **One group id per process.** `loadConfig` resolves the group once; the consumer, its DLQ topic and the
  `--once` report's DLQ count all take it from there, so an override can never consume one group while it
  watches another's dead letters (#599).
- **Why not `createConsumer`?** It runs one handler per message and commits per kafkajs batch. A ClickHouse
  insert per message is the wrong shape, and buffering across messages inside a handler cannot wait for the ack
  before the SDK commits. So this package runs its own `eachBatch` loop over the SDK's wire format
  (`decodeMessage`), DLQ topic plan (`planTopics`/`ensureTopics`), `DeadLetter` record, `readDeadLetters` and
  validator.
- **Per partition, only what was acknowledged.** Each partition batch commits its own offset, and only after
  its rows are in an acknowledged insert. A rebalance or a crash mid-flush commits nothing for that batch, so it
  is replayed in full and ReplacingMergeTree folds the duplicates. The batch heartbeats every 2 s while it
  waits for the flush, so a slow ClickHouse (it is memory-capped on the laptop) does not trigger a rebalance storm.
- **Writer and reader.** The ingest and `ch:migrate` use the writer (`CLICKHOUSE_USER`, which pins
  `async_insert = 0`). Readers (`createChReader`, the read-only `CLICKHOUSE_READONLY_USER`) send no per-query
  settings, because a `readonly = 1` user is refused any. Tests that need DDL use the writer on a throwaway
  `analytics_test_<word>` database and drop it. `analytics` itself is never dropped (the reader's grant is bound
  to it).
- **No PII.** Events carry ids, hashes, amounts and countries only. `payload` is the event's payload verbatim as
  JSON text, and a test sweeps a generated month over every topic for e-mail, phone, name and address shapes.
- **Money** stays inside `payload` in integer minor units beside its currency. Nothing here sums anything.

## Run

| Command                                                  | What                                                                                                                                                                                                                                                           |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @platform/analytics-ingest ch:migrate`    | applies `data/clickhouse/migrations/*.sql` (each once; an edited applied file is refused) and then `data/clickhouse/models/*.sql` (views, re-applied when changed) to `CLICKHOUSE_DATABASE` (creates it), under `_migrations_lock`, after the idempotency lint |
| `pnpm --filter @platform/analytics-ingest dev` / `start` | long-running consumer; `GET /health` on `$PORT` when set (the container contract; readiness, see Deploying)                                                                                                                                                    |
| `pnpm --filter @platform/analytics-ingest once`          | `--once`: drain to idle (≥ `ANALYTICS_MIN_RUN_MS`, then `ANALYTICS_IDLE_MS` quiet, hard stop `ANALYTICS_MAX_RUN_MS`), print one JSON report (rows per topic, dead letters this run, records on the group's DLQ), exit 0 (1 on max_run)                         |

Flags: `--once`, `--group <id>`, `--topic-prefix <p>` (tests and gates; applies to the DLQ too).

| Variable                                                    | Default                                                                                                                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLICKHOUSE_URL`                                            | `http://127.0.0.1:18123`                                                                                                                                |
| `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD`                   | `default` / empty — the ADMIN: `ch:migrate` (it creates the users) and `reconcile` only                                                                 |
| `CLICKHOUSE_INGEST_USER` / `CLICKHOUSE_INGEST_PASSWORD`     | the ingest's writer `analytics_ingest` (#648, data/clickhouse/access); unset = the admin with a `writer_is_admin` warning in dev, refused in production |
| `CLICKHOUSE_READONLY_USER` / `CLICKHOUSE_READONLY_PASSWORD` | readers only (`analytics_ro`)                                                                                                                           |
| `CLICKHOUSE_DATABASE`                                       | `analytics`                                                                                                                                             |
| `KAFKA_BROKERS`                                             | `127.0.0.1:19092`                                                                                                                                       |
| `ANALYTICS_GROUP_ID`                                        | `analytics.raw`                                                                                                                                         |
| `ANALYTICS_TOPIC_PREFIX`                                    | empty                                                                                                                                                   |
| `ANALYTICS_BATCH_SIZE` / `ANALYTICS_FLUSH_MS`               | 5000 rows / 1000 ms                                                                                                                                     |
| `ANALYTICS_CONCURRENCY`                                     | 8 partitions at once (the buffer fills across them)                                                                                                     |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                               | unset = no export                                                                                                                                       |
| `ANALYTICS_READY_STALE_MS`                                  | 300000 (5 min; ≥ 10000): `/health` turns 503 after this long without progress                                                                           |

## Deploying (#641)

- **`GET /health` is readiness, not just "the process is up".** 200 only while ALL hold, 503 otherwise:
  - the consumer is a member of its group (not before the first join, nor while rebalancing, crashed or stopped);
  - it made progress within `ANALYTICS_READY_STALE_MS` — a fetch completed (an idle consumer fetches every few
    seconds, so a quiet bus stays ready) or a batch was committed;
  - no batch has been in flight longer than that (ClickHouse or the DLQ not acknowledging): a hung batch on any
    partition fails it even while other partitions fetch. kafkajs 2's FETCH event cannot tell an empty fetch from a
    full one, hence this check.

  The body carries the inputs (`joined`, `progress_age_ms`, `last_commit_age_ms`, `oldest_in_flight_ms`, the group).
  The image's `HEALTHCHECK` and the chart's startup / readiness / liveness probes all point at `/health`: startup
  covers the join (the chart allows 150 s), liveness restarts a stuck consumer. Nothing is lost by a restart: offsets
  move only after the ClickHouse and DLQ acks, so the uncommitted batch comes back.

- **One replica, deployed with `Recreate`, never a surge (#641 item 1).** The single-replica guard (`SecondReplicaError`,
  Erasure below) refuses to start while the group has live members. After a SIGKILL or an OOM the dead member stays in
  the group until its session times out (`sessionTimeout` 30 s), and during a rolling update with surge the old pod
  is still a member. So:
  - **deployment strategy `Recreate`** (the old pod is gone before the new one starts), `replicas: 1`, no autoscaling;
  - **a restart backoff above 30 s** (the orchestrator's first restarts after a crash otherwise exit 1 on
    `SecondReplicaError` until the dead member expires; Kubernetes' CrashLoopBackOff reaches that on its own after a
    few attempts, and `restartPolicy` must stay `Always`).

  The chart (`infra/helm/platform-app`, window 5) sets no `strategy` today, which means RollingUpdate with surge: the
  ingest's values need `Recreate` there (REQUEST #647 to window 5). A crash-loop of a few exits after a hard
  kill is expected and harmless: no batch is committed by a process that exits.

## Metrics (OpenTelemetry, exported only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set)

| Instrument                         | Kind                                                                                                         | Attributes               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------ |
| `analytics_ingest.consumer_lag`    | gauge, messages behind the high watermark after the last committed batch                                     | topic, partition         |
| `analytics_ingest.ingest_delay`    | histogram, ms from the relay's publish (Kafka timestamp) to the ClickHouse ack (the gate's "lag p95 < 10 s") | none                     |
| `analytics_ingest.rows_inserted`   | counter                                                                                                      | topic                    |
| `analytics_ingest.dead_lettered`   | counter                                                                                                      | event_topic, error_class |
| `analytics_ingest.insert_duration` | histogram, ms per acknowledged insert                                                                        | none                     |

## Tests

`pnpm --filter @platform/analytics-ingest test`. The unit tests need nothing:

- `rows.test.ts`: the row mapping; unknown version, unknown topic, schema failure and undecodable message all go
  to the DLQ; dead letters carry exactly the SDK fields (no payload); every topic@version is accepted.
- `batcher.test.ts`: size flush, time flush, resolve only after the ack, a failed insert rejects only its callers,
  inserts in order.
- `ingest.test.ts`: commit after the ack; no commit when the insert or the DLQ fails; a replay of the same batch
  leaves `count() FINAL` unchanged; a crash between insert and commit duplicates rows that FINAL folds; a whole
  generated month lands once per (topic, event_id).
- `pii.test.ts`: the sweep (and a planted row proving the sweep finds each shape).
- `migrations.test.ts`: the DDL; the idempotency lint over both SQL folders; migrations then models; a second run
  applies nothing; an edited model is re-applied while an edited migration is refused; the lock refuses a second
  runner and is always released.
- `config.test.ts` (group override moves the DLQ, #599), `once.test.ts` (the stopping rule), `metrics.test.ts`
  (in-memory OTel exporter).

`models.test.ts` runs the models (data/clickhouse/README.md) on the shared month from `@platform/test-utils`: 150
orders over three legal entities, with refunds, cancellations before and after partial shipments, and unknown fees.
The events are written straight into `raw_events` of two throwaway databases. The tests check:

- one row per fact key;
- `product_id` through `dim_variant`;
- `mart_bookings_daily` and `mart_cash_daily` row for row against references computed from the same events with
  `rpt_sales_daily`'s / `rpt_payments_daily`'s rules (Postgres = ClickHouse itself is #602's);
- a second database fed in reverse, every event twice, with the MV created midway, gives identical marts and
  tiles;
- exact live counts;
- no PII-named column.

It needs ClickHouse only, with the same gate as `live.test.ts`.

`live.test.ts` runs the real thing against Redpanda and ClickHouse: migrate twice, a month published under a
throwaway prefix into a throwaway database (once per topic; invalid events on the overridden group's DLQ), a full
replay into a fresh group (no count changes), and a crash between insert and commit (FINAL folds). It is
**opt-in** on a laptop (`ANALYTICS_LIVE=1`, only while you hold the machine; CI always opts in), then skipped with
a printed reason when ClickHouse is down or refuses the configured user, or the broker is down.

The generated month (`src/testing/month.ts`) is built from the schemas themselves: every topic and version of
`@platform/events`, seeded, validated with the real validator. A new topic is covered the day it lands.

## Reconcile: the Integration 5 money identities (#602)

`pnpm --filter @platform/analytics-ingest reconcile --from 2026-10-01 --to 2026-11-01 [--store <uuid>] [--json]`
pulls the ledger's own journal lines through the Finance API into ClickHouse (`ledger_lines`, read as
`fct_ledger_line`), runs every identity and prints one table per identity with the first 20 differences. Exit 0
only when every difference is 0 (1 on a difference, 2 on a usage or read error). It reads ONLY public APIs over HTTP:
the core's `getHqSalesReport` / `getHqFinanceReport` (`CORE_URL`, `CORE_TOKEN`: analyst and finance, e.g. owner)
and the Finance API (`ACCOUNTING_URL`, `ACCOUNTING_TOKEN`: finance), plus ClickHouse (`CLICKHOUSE_*`). No posting
rule exists in this package: the ledger side is always the ledger's lines or its own aggregates (D7).

| Identity                          | Left                                     | Right                                                                                                                                  | Key                                              |
| --------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1 bookings                        | `mart_bookings_daily`                    | core `getHqSalesReport`                                                                                                                | store × UTC day × currency                       |
| 2a copy integrity (lines)         | Finance API `listJournalLines` as served | `fct_ledger_line`                                                                                                                      | legal entity × currency × day × account          |
| 2a copy integrity (trial balance) | Finance API `getTrialBalance`            | `fct_ledger_line`                                                                                                                      | legal entity × currency × account                |
| 2b lineage                        | revenue lines (4000/4010/4090)           | `raw_events` shipment.shipped / refund.issued; every shipment.shipped has lines unless parked (`listParkedEvents`)                     | line / event                                     |
| 2c lifetime invariant             | order.placed `total − tax`               | ledger 4000 + 4010 of its shipments                                                                                                    | fully shipped, never cancelled, unrefunded order |
| 3a captures and fees              | `mart_cash_daily`                        | core `getHqFinanceReport`, one UTC day at a time                                                                                       | store × day × currency                           |
| 3b capture entries                | `raw_events` payment.captured            | Σ debits of the ledger's payment.captured entries (1100 net of the fee + 6100 the fee = the gross; 1100 alone would copy the fee rule) | legal entity × currency × day                    |
| 3c payouts                        | Finance API `listPayouts`                | ledger 1000 debits from psp.payout                                                                                                     | legal entity × currency                          |

A key present on one side only is compared against 0, so a missing row is a difference. Mind the dates: the Admin
API reports take `[from, to)`, the Finance API `[from, to]`; the clients translate.

**The gate** is `apps/core/src/modules/reporting/reconcile-gate.test.ts`. It sends the generated month through the
production topology: the real relay, the real ledger and this ingest in fresh groups. It then runs `reconcile`
against the core's report routes mounted in-process and the Finance API (verifier seam), and checks that every
identity is 0. It also checks that a forged ledger copy and a changed order are both caught. It runs in the live job
only.

## Erasure: `customer.erased` (#623)

Orders are kept; the person is not. When a customer is erased, their identifiers leave every readable table and view
of the analytics store. That covers `email_hash`, `customer_id`, `identity_id`, and the customer ids a referral
carries, in every schema that has one.

- **At insert, replays included.** The ingest loads `customer_erasures` at start and scrubs every row it classifies
  against it, before the row is buffered. A replay, a late event or a rebuild can never put an erased identifier back.
- **On `customer.erased`**, scoped to the event's store (or the whole organization when it has none), after its own
  batch is acknowledged and before the commit:
  1. record the erasure and add it to the index;
  2. flush the insert buffer;
  3. re-insert that customer's stored rows scrubbed, with a later `ingested_at`, so they win;
  4. `DELETE` the older versions, so not even a non-FINAL read sees them.

  Every step is idempotent: a crash redelivers and the steps run again.

- **The index can run ahead of the erasure list: an over-scrub, never an under-scrub (#641 item 4).** Step 1 adds the
  digests to the in-memory index BEFORE the `customer_erasures` insert is acknowledged, so the flush in step 2
  already scrubs. If that insert then fails, the batch is not committed, but rows classified in the meantime by this
  process (other partitions) are scrubbed for a customer the list does not hold yet. That is deliberate: the safe
  direction for personal data. The batch redelivers, the insert succeeds, and the list catches up with the index; a
  restart before that reloads the index from the list without the digest, and the redelivered `customer.erased`
  adds it again. Nothing is ever scrubbed that the customer did not ask for, and no row stays unscrubbed once its
  erasure is committed.

- **No raw identifier in the erasure list.** `customer_erasures.digest` = HMAC-SHA256 under `ANALYTICS_ERASURE_KEY` (env
  or Vault) of `<store>:<kind>:<value>`; without the key it links to nobody. **The ingest refuses to start without the
  key**, and a batch holding a `customer.erased` is never committed by an ingest without an erasure handler (fail
  closed).
- **Models.** `fct_order.customer_key` (the pseudonymous key, `email_hash`) is NULL once erased. The erased customer's
  money stays in every money mart. `mart_customers_daily` counts their orders as `unknown_orders`. A customer is `new`
  on the day of their first order in a store and `returning` on any later day.
- **Out of scope:** the bus keeps the original payloads for its retention (windows 13/14).
- **No identifier in SQL text or logs.** The rows to scrub are found with server-side parameters, and every later
  statement uses event ids only. Every erasure statement runs with `log_queries = 0`. A test checks that
  `system.query_log`, `query_views_log` and `processes` hold neither the hash nor the customer id afterwards.
  The lookup that carries the identifiers sends its parameters (and its SQL) in the multipart BODY
  (`use_multipart_params`). In the URL (`param_v0=<hash>`) they would reach HTTP trace logs and any proxy or
  load-balancer access log, which `log_queries = 0` does not cover. A test runs the real client against a recording
  server and asserts that no URL carries them.
- **Every identifier field.** `email_hash`, `customer_id`, `identity_id`, `referrer_customer_id`,
  `referee_customer_id`, the envelope `aggregate_id` of a customer event, and `requested_by` when
  `requested_by_type = 'customer'` (customer.export_requested v2, customer.export_ready; v1 and staff requests name a
  staff user, which stays).
- **ONE replica in Phase 5.** The erasure index is per process, loaded at start, so a second replica would not see
  the other's erasures until it restarts. Before joining, the ingest describes its consumer group and refuses to
  start (`SecondReplicaError`) when the group already has live members. That is best effort: kafkajs offers no atomic
  "join only if alone", so two processes started in the same instant can both see an empty group. Deploy it as a
  single replica (no autoscaling). The multi-replica fix, a periodic index refresh + re-scrub, is on
  docs/launch-checklist.md.
- **Physical removal.** The lightweight `DELETE` hides the old versions at once. `OPTIMIZE TABLE raw_events PARTITION
ID '<p>' FINAL` then rewrites only the affected partitions (bounded), so the bytes are gone too. The test sweep reads
  with `apply_deleted_mask = 0`.
- **No race with classification.** The index update and the start of the buffer flush happen in the same synchronous
  tick, and classify → buffer is synchronous. So every row is either classified after the update (scrubbed at insert)
  or already in the buffer being flushed (scrubbed by the rewrite). A randomised test interleaves a customer's orders
  and their erasure across partitions (15 seeds, random latency and buffer sizes) and checks they converge every time.

### Rotating `ANALYTICS_ERASURE_KEY`

A new key cannot match the old digests, so rotation rebuilds the list from the durable source of erasures: the
core's OUTBOX (`customer.erased` rows), replayed by the core's `outbox:replay` (#595). The bus is not that source:
`customer.*` topics keep 30 days, #629.

1. Stop the ingest, set the new key (Vault), and note the time T.
2. `pnpm --filter @platform/core outbox:replay --topic customer.erased` republishes every erasure.
3. Start the ingest. It consumes the replayed erasures and records them under the new key. Each re-scrub is a no-op
   for rows already scrubbed. An order of an erased customer that lands before its replayed erasure is scrubbed when
   the erasure arrives, so the rebuild converges.
4. Once the replay has drained, `DELETE FROM customer_erasures WHERE recorded_at < T`: the old digests match nothing
   now.

This needs the outbox to keep `customer.erased` rows; any outbox pruning must exempt them.

`erasure.test.ts` covers the digests, the scrub and classify (unit). Against ClickHouse it checks four things:

- the erased hash and id are in no table or view, by a non-FINAL `formatRow` sweep;
- the other customers are untouched;
- the money marts are unchanged;
- a full replay through a fresh ingest keeps the identifiers gone, and an erasure that arrives before the orders
  scrubs them at insert.
