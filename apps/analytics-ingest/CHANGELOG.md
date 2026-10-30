# Changelog — @platform/analytics-ingest

## 0.8.0 — unreleased (#648, the ClickHouse re-review: items 1, 4, 5)

- `data/clickhouse/access/`: the users as versioned SQL, applied by `ch:migrate` after the models on every run
  (`applyAccess`, `readAccessFiles`, `lintAccessFiles`): passwords from env hashed at run time, `log_queries = 0`, a
  users.d user skipped with the reason, a missing password fatal in production.
- `analytics_ingest` (least privilege) and the ingest switched to it (`CLICKHOUSE_INGEST_USER` / `_PASSWORD`;
  `IngestConfig.ingestClickhouse`); the admin stays for the migrator and reconcile.
- `analytics_ro` as SQL with per-user bounds: `max_concurrent_queries_for_user = 16`,
  `max_memory_usage_for_user = 768 MB`, a 1200-queries-a-minute quota.

## 0.7.0 — unreleased (#641, the ingest's operational re-review)

- `GET /health` is readiness: 200 only while the consumer is joined, made progress (a fetch or a commit) within
  `ANALYTICS_READY_STALE_MS` (default 5 min) and holds no batch in flight past it; 503 otherwise, with the inputs in
  the body (`healthVerdict`, `healthAnswer`, `Ingest.health()`). A stuck consumer is restarted by liveness.
- `createIngest` derives the DLQ topic (`<prefix>dlq.<group>`) itself: `IngestOptions.config` no longer takes
  `dlqTopic`, so a caller cannot split the DLQ from its group.
- README "Deploying": one replica with the `Recreate` strategy and a restart backoff above 30 s (the single-replica
  guard vs a dead member's session timeout); the probes. Erasure: the in-memory index can run ahead of
  `customer_erasures` (an over-scrub only, idempotent on redelivery).

## 0.6.0 — unreleased (#604, #628 review)

- The alias-shadow lint (`sql-lint.ts`) and the two model fixes it found.
- The migration lock renews its claim every 2 minutes while a run lasts (a run longer than the 10-minute TTL keeps
  the lock) and sweeps stale claims of crashed runners on acquire (#628 review, finding 3); `renewed_at` added to
  existing lock tables with ADD COLUMN IF NOT EXISTS.

## 0.5.0 — unreleased (#623)

- `customer.erased` honoured (`src/erasure.ts`): HMAC digest index (`ANALYTICS_ERASURE_KEY`, required), scrub at classify
  (replays included), `applyErasure` (record → flush → re-insert scrubbed → DELETE old versions) before the commit;
  migration 0004 `customer_erasures`; `fct_order.customer_key` + `mart_customers_daily` (new / returning / unknown).
  A batch with a customer.erased never commits without an erasure handler. Tests: `erasure.test.ts`.

## 0.4.0 — unreleased (#602)

- `reconcile` (`src/reconcile/`, `src/reconcile-cli.ts`): the Finance API and HQ report clients (generated contract types;
  inclusive vs exclusive `to`), the ledger pull into `ledger_lines` (migration 0003) / `fct_ledger_line` (model 350),
  the identities 1, 2a, 2b, 2c, 3a, 3b, 3c, the runner and the report (first 20 differences, exit 0 only at 0). No
  posting rule anywhere (D7). Unit tests: the diff, the paging, the date conventions, errors, the report.
- The gate lives in apps/core/src/modules/reporting/reconcile-gate.test.ts (the core report routes in-process).

## 0.3.0 — unreleased (#601)

- #601 P5.2 models in `data/clickhouse/models/`: staging views for 10 topic versions, `dim_variant`, `dim_store`,
  `fct_order`, `fct_order_line` (the binding interface for window 9), `fct_payment`, `fct_refund`,
  `fct_shipment_line`, `mart_bookings_daily` (the rules of rpt_sales_daily), `mart_cash_daily` (the rules of
  rpt_payments_daily) and `live_orders_minute`. Migration `0002_orders_minute.sql`: `orders_minute_events`
  (ReplacingMergeTree keyed (store_id, currency, minute, event_id)), `mv_orders_minute` and a backfill.
  `mart_recognised_daily` was dropped (D7).
- The runner moved to `src/migrations.ts`. Models are plain views, re-applied when their text changes; migrations
  are still refused when edited. New: an idempotency lint (`lintSqlFiles`), run before every migrate and by a test
  over both folders, and the `_migrations_lock` claim (review follow-up 4 on #616).
- A schema-valid event whose row ClickHouse would refuse (a timestamp outside DateTime64) is dead-lettered as
  `InsertRejectedError` before it is buffered, instead of failing the insert and stalling the ingest (review
  follow-up 2 on #616).
- `createChReader` for the read-only user (sends no per-query settings).
- Tests: `models.test.ts` (opt-in like live.test) runs the models on the shared month from `@platform/test-utils`
  (150 orders, three legal entities).

## 0.2.0 — 2026-10-25

- #600 P5.1: the ingest. A kafkajs `eachBatch` consumer (group `analytics.raw`, overridable; the DLQ and the
  `--once` report follow the same group, #599) over every topic of `@platform/events`, from the beginning, into
  ClickHouse `raw_events` (`data/clickhouse/migrations/0001_raw_events.sql`: ReplacingMergeTree on
  `(topic, event_id)`, version `ingested_at`).
- Shared insert buffer with size and time flush; the partition offset is committed only after the ClickHouse
  insert and the dead letters are acknowledged.
- Undecodable messages, unknown topics or versions, and schema failures go to `dlq.<group>` in the SDK's
  `DeadLetter` shape (no payload).
- `ch:migrate`: an idempotent runner (`_migrations` with sha256 per file; a changed applied file is refused).
- `--once` drain mode with a JSON report; `GET /health` on `$PORT` (the container contract); OpenTelemetry metrics
  (consumer lag, ingest delay, rows, dead letters, insert duration) when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
- Dependencies (exact): `@clickhouse/client` 1.24.1, `kafkajs` 2.2.4, `@opentelemetry/api` 1.9.1,
  `@opentelemetry/sdk-metrics` 2.12.0, `@opentelemetry/exporter-metrics-otlp-http` 0.223.0,
  `@opentelemetry/resources` 2.12.0.
- Tests: 41 unit tests (mapping and DLQ routing, batcher, commit-after-ack, replay and crash folding, PII sweep over
  a schema-generated month of every topic and version, config, migrations, metrics) and 4 opt-in live tests.

## 0.1.0 — 2026-09-04

- Scaffold created by the main window (Phase 0).
