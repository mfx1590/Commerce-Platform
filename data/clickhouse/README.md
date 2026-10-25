# data/clickhouse — the analytics store (Phase 5, D1–D3)

ClickHouse is the only analytics store. It is fed from the bus by `apps/analytics-ingest` (no CDC, no PII), and
its schema is versioned SQL in this folder, applied by
`pnpm --filter @platform/analytics-ingest ch:migrate`. Owner: window 12.

| Folder        | What                                                                                       | Applied                                                                                | Since |
| ------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ----- |
| `migrations/` | tables, materialised views and their TO tables                                             | in file-name order, each file once; editing an applied file is refused (add a new one) | #600  |
| `models/`     | plain views only (`CREATE OR REPLACE VIEW`): staging, dimensions, facts, marts, live tiles | after the migrations, in file-name order; re-applied whenever the file's text changes  | #601  |

`_migrations` keeps a sha256 per file (models as `models/<file>`). The runner relies on every statement being
idempotent, so a file that failed halfway can simply run again. A test lints both folders and accepts only:

- `CREATE … IF NOT EXISTS` and `ALTER TABLE … ADD COLUMN IF NOT EXISTS` in migrations;
- `INSERT … SELECT` into a ReplacingMergeTree table (a backfill whose copies fold);
- `CREATE OR REPLACE VIEW` in models.

`_migrations_lock` keeps two runners apart: the oldest live claim wins (TTL 10 minutes), and the other refuses.
Materialised views never go in `models/`: re-creating an MV that has no TO table drops its data.

## raw_events (#600)

One row per bus event, every topic and version, written by the ingest.

| Column                           | Type                           | From                                                          |
| -------------------------------- | ------------------------------ | ------------------------------------------------------------- |
| `topic`, `version`               | LowCardinality(String), UInt16 | envelope                                                      |
| `event_id`                       | UUID                           | envelope (= the outbox id, the idempotency key)               |
| `organization_id`, `store_id`    | UUID, Nullable(UUID)           | envelope (`store_id` null for organization-scope events)      |
| `aggregate_type`, `aggregate_id` | LowCardinality(String), String | envelope                                                      |
| `occurred_at`                    | DateTime64(3, 'UTC')           | envelope                                                      |
| `published_at`                   | DateTime64(3, 'UTC')           | the Kafka message timestamp (the relay's publish)             |
| `payload`                        | String                         | the event payload verbatim, as JSON text                      |
| `ingested_at`                    | DateTime64(3, 'UTC')           | when the ingest built the row; the ReplacingMergeTree version |

`ENGINE = ReplacingMergeTree(ingested_at) PARTITION BY toYYYYMM(occurred_at) ORDER BY (topic, event_id)`.
A redelivered event lands in the same partition (same `occurred_at`) and is folded at merge time. **Until then,
count with `FINAL`**: `SELECT topic, count() FROM raw_events FINAL GROUP BY topic`.

## Models (#601)

Every model is a view that reads `raw_events FINAL` (directly or through staging), so a redelivered or replayed
event counts once and a late event lands where it belongs. Nothing is materialised except the live tiles.

| Layer      | Views                                                                                                                                                                                                                                                        | Grain                                                | Source                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| staging    | `stg_order_placed_v1`, `stg_order_cancelled_v1`, `stg_payment_captured_v1`, `stg_payment_failed_v1`, `stg_refund_issued_v1`, `stg_shipment_shipped_v1`, `stg_product_published_v1`, `stg_product_updated_v1`, `stg_store_created_v1`, `stg_store_updated_v1` | one row per event                                    | `raw_events` of that topic and version, payload as typed columns                                  |
| dimensions | `dim_variant`                                                                                                                                                                                                                                                | (store_id, variant_id)                               | `variants[]` of product.published / product.updated; the latest event wins                        |
|            | `dim_store`                                                                                                                                                                                                                                                  | store_id                                             | store.created (legal entity, name, default currency) + store.updated (code, status; latest)       |
| facts      | `fct_order`                                                                                                                                                                                                                                                  | order_id                                             | order.placed; `order_status` = `cancelled` once an order.cancelled exists, else `placed`          |
|            | `fct_order_line`                                                                                                                                                                                                                                             | order_line_item_id                                   | order.placed `line_items[]`, `product_id` through `dim_variant`                                   |
|            | `fct_payment`                                                                                                                                                                                                                                                | (payment_id, status)                                 | payment.captured (`captured`, with `fee_minor`, NULL while unknown) and payment.failed (`failed`) |
|            | `fct_refund`                                                                                                                                                                                                                                                 | refund_id                                            | refund.issued (succeeded refunds)                                                                 |
|            | `fct_shipment_line`                                                                                                                                                                                                                                          | (shipment_id, order_line_item_id)                    | shipment.shipped `items[]` (lineage and #602's lifetime invariant; no posting rule)               |
| marts      | `mart_bookings_daily`                                                                                                                                                                                                                                        | organization × store × UTC day × currency            | `fct_order` + `fct_refund`, **the rules and columns of Postgres `rpt_sales_daily`**               |
|            | `mart_cash_daily`                                                                                                                                                                                                                                            | organization × store × UTC day × currency × provider | `fct_payment`, **the rules and columns of Postgres `rpt_payments_daily`**                         |
| live       | `live_orders_minute`                                                                                                                                                                                                                                         | store × currency × minute                            | `orders_minute_events` FINAL (written by `mv_orders_minute`, migration 0002)                      |

Staging leaves out what no fact needs, `email_hash`, `customer_id` and titles in particular, so no model carries a
PII-shaped column (a test checks `system.columns`).

### Identities

- **Bookings** (`mart_bookings_daily`): orders by placement day, excluding cancelled orders and orders whose payment
  failed and was never captured. Refunds are cohort-attributed to the order's placement day, so
  `net_minor = total_minor − refunded_minor`. The model tests (#601) prove it equals a reference computed from the
  same events with `rpt_sales_daily`'s rules. #602 proves it equals `rpt_sales_daily` itself, row for row.
- **Cash** (`mart_cash_daily`): captures by capture day and provider. `fee_minor` sums the known fees and
  `fee_unknown` counts the captures whose fee is not reported yet, the same as `rpt_payments_daily`.
- **Recognised revenue** has no mart: `mart_recognised_daily` was dropped. Revenue is booked at shipment by the
  ledger, and ClickHouse never recomputes it (D7). #602 pulls the ledger's own posted lines and checks them
  against `fct_shipment_line` and `raw_events`.

Money is Int64 minor units beside its currency in every model. Nothing is ever summed across currencies (every mart
groups by currency).

### Live tiles

`mv_orders_minute` sees every insert into `raw_events`, redeliveries included, so it does not aggregate. It writes
one row per order.placed event into `orders_minute_events`, a ReplacingMergeTree ordered by
`(store_id, currency, minute, event_id)`, where copies of an event fold. `live_orders_minute` aggregates at read
time over FINAL: `uniqExact(order_id)` (never the approximate `uniq`) and `sum(total_minor)` per currency. It counts
every placed order, cancelled ones included (a live order count, not bookings). Migration 0002 backfills what
`raw_events` held before the MV existed.

### fct_order_line: the interface window 9 reads (binding, #607)

Changes after #601 merges are additive only.

| Column                                                           | Type                                           | From                                                                            |
| ---------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------- |
| `organization_id`, `store_id`                                    | UUID                                           | envelope                                                                        |
| `order_id`                                                       | UUID                                           | order.placed                                                                    |
| `order_line_item_id`                                             | UUID (the grain; unique)                       | line item                                                                       |
| `variant_id`                                                     | Nullable(UUID)                                 | line item                                                                       |
| `product_id`                                                     | Nullable(UUID)                                 | `dim_variant`; NULL when the variant was never published (or the line has none) |
| `sku`                                                            | String                                         | line item                                                                       |
| `quantity`                                                       | UInt32                                         | line item                                                                       |
| `unit_price_minor`, `discount_minor`, `tax_minor`, `total_minor` | Int64                                          | line item                                                                       |
| `currency`                                                       | LowCardinality(String)                         | order.placed                                                                    |
| `placed_at`                                                      | DateTime64(3, 'UTC')                           | order.placed                                                                    |
| `order_status`                                                   | LowCardinality(String): `placed` / `cancelled` | latest of order.placed / order.cancelled                                        |
| `source_event_id`                                                | UUID                                           | the order.placed event                                                          |

Recommendations exclude `order_status = 'cancelled'`. `dim_variant` (store_id, variant_id, product_id, sku,
last_seen_at) is published beside it.

### Worked example

One Brand A order of two lines placed on 2026-10-03 and paid (captured the same day, fee 312). Line 1 is
2 × 1,000 with tax 420; line 2 is 1 × 500 with discount 100 and tax 84. Shipping is 495 with tax 104, so the total
is 3,503. Line 2 is shipped, then the order is partly refunded (800, a return).

| Model                                       | Row                                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `fct_order`                                 | total_minor 3,503, order_status `placed`                                                                |
| `fct_order_line`                            | two rows; `product_id` is set for the published variant, NULL for the other                             |
| `fct_shipment_line`                         | one row: line 2, quantity 1                                                                             |
| `mart_bookings_daily` (2026-10-03, EUR)     | orders 1 · gross 2,500 · discount 100 · shipping 495 · tax 608 · total 3,503 · refunded 800 · net 2,703 |
| `mart_cash_daily` (2026-10-03, EUR, stripe) | captured_count 1 · captured 3,503 · fee 312 · fee_unknown 0                                             |
| `live_orders_minute` (its minute, EUR)      | orders 1 · total 3,503                                                                                  |

Had the order been cancelled, it would leave `mart_bookings_daily` (as in `rpt_sales_daily`). It would stay in
`live_orders_minute` and `mart_cash_daily`, because its capture happened, and the refund shows in `fct_refund`.

Rules for everything built here: money stays in integer minor units beside its currency and is never summed across
currencies; there is no PII; ClickHouse never recomputes ledger revenue (D7).
