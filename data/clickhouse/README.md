# data/clickhouse — the analytics store (Phase 5, D1–D3)

ClickHouse is the only analytics store. It is fed from the bus by `apps/analytics-ingest` (no CDC, no PII), and
its schema is versioned SQL in this folder, applied by
`pnpm --filter @platform/analytics-ingest ch:migrate`. Owner: window 12.

| Folder        | What                                                                                                                                             | Since |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| `migrations/` | tables, applied in file-name order, each file once (`_migrations` keeps a sha256 per file; editing an applied file is refused, so add a new one) | #600  |
| `models/`     | staging, facts, marts and `mv_orders_minute`                                                                                                     | #601  |

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

Rules for everything built on it: money stays in integer minor units beside its currency and is never summed across
currencies; there is no PII (events carry ids, hashes, amounts and countries only); ClickHouse never recomputes
ledger revenue (D7). Recognised revenue comes from the ledger's own posted lines.
