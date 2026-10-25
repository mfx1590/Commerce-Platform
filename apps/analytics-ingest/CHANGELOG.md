# Changelog — @platform/analytics-ingest

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
