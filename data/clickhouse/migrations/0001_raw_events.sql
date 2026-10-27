-- raw_events (#600, D2): one row per bus event, every topic, written by apps/analytics-ingest.
--
-- Exactly once IN EFFECT: the ingest commits a Kafka offset only after ClickHouse acknowledged the insert, so a
-- crash in between redelivers and re-inserts the same events. ReplacingMergeTree keyed (topic, event_id) folds
-- those copies at merge time; every reader that counts must use FINAL (or argMax by ingested_at) until then.
-- `ingested_at` is the version column: of two copies the later insert wins, and both carry the same envelope.
--
-- No PII: events carry ids, hashes, amounts and countries only (packages/events rules); `payload` is the event's
-- payload verbatim as JSON text. Money stays inside it in integer minor units beside its currency.
CREATE TABLE IF NOT EXISTS raw_events
(
    topic            LowCardinality(String),
    version          UInt16,
    event_id         UUID,
    organization_id  UUID,
    store_id         Nullable(UUID),
    aggregate_type   LowCardinality(String),
    aggregate_id     String,
    occurred_at      DateTime64(3, 'UTC'),
    published_at     DateTime64(3, 'UTC'),
    payload          String,
    ingested_at      DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (topic, event_id);
