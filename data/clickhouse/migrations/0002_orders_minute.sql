-- Live tiles (#601, D6): orders per store × currency × minute, polled every 15 s.
--
-- A materialised view sees EVERY insert into raw_events, redeliveries included (the ingest re-inserts a batch whose
-- commit it lost), so it must not sum anything itself: a sumState or a plain count would double-count. It writes
-- one row per order.placed event into a ReplacingMergeTree keyed (store_id, currency, minute, event_id); copies of
-- the same event fold, and the tile aggregates at read time over FINAL (models/500_live.sql: uniqExact orders,
-- sum of totals per currency, never across currencies).
--
-- The MV and its TO table live here, not in models/: re-creating an MV without a TO table drops its data.
CREATE TABLE IF NOT EXISTS orders_minute_events
(
    store_id     UUID,
    currency     LowCardinality(String),
    minute       DateTime('UTC'),
    event_id     UUID,
    order_id     UUID,
    total_minor  Int64,
    ingested_at  DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(minute)
ORDER BY (store_id, currency, minute, event_id);

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_orders_minute TO orders_minute_events AS
SELECT
    assumeNotNull(store_id)                             AS store_id,
    JSONExtractString(payload, 'currency')              AS currency,
    toStartOfMinute(occurred_at)                        AS minute,
    event_id,
    toUUID(JSONExtractString(payload, 'order_id'))      AS order_id,
    JSONExtractInt(payload, 'totals', 'total_minor')    AS total_minor,
    ingested_at
FROM raw_events
WHERE topic = 'order.placed' AND version = 1 AND store_id IS NOT NULL;

-- The MV only sees inserts made after it exists: backfill what raw_events already holds. Rows that arrive between
-- the two statements are written twice and fold (same event_id).
INSERT INTO orders_minute_events
SELECT
    assumeNotNull(store_id)                             AS store_id,
    JSONExtractString(payload, 'currency')              AS currency,
    toStartOfMinute(occurred_at)                        AS minute,
    event_id,
    toUUID(JSONExtractString(payload, 'order_id'))      AS order_id,
    JSONExtractInt(payload, 'totals', 'total_minor')    AS total_minor,
    ingested_at
FROM raw_events FINAL
WHERE topic = 'order.placed' AND version = 1 AND store_id IS NOT NULL;
