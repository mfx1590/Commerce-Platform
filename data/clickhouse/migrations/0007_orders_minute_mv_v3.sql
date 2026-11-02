-- #696 gate: the live orders tile reads order.placed v1 AND v2. v2 is v1 with email_hash nullable (an erased
-- customer, scrubbed by the outbox replay) and changes nothing this view reads, but mv_orders_minute_v2 (0006)
-- filters `version = 1`, so once v2 is published every new order would be missing from the tile.
--
-- 0006's order, for the same reasons:
--   1. the new MV first. From here both MVs write every v1 insert; copies fold (same ReplacingMergeTree key) and
--      the tile reads FINAL.
--   2. the old MV dropped. An insert already running keeps the views it began with; later ones see only the new one.
-- No backfill and no DELETE: this is applied before #696 publishes v2, so raw_events holds no v2 order yet (the
-- ingest dead-letters an unknown version until then), and the v1 rows are already in the table.
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_orders_minute_v3 TO orders_minute_events AS
SELECT
    assumeNotNull(r.store_id)                           AS store_id,
    JSONExtractString(r.payload, 'currency')            AS currency,
    toStartOfMinute(r.occurred_at)                      AS minute,
    r.event_id                                          AS event_id,
    toUUID(JSONExtractString(r.payload, 'order_id'))    AS order_id,
    JSONExtractInt(r.payload, 'totals', 'total_minor')  AS total_minor,
    r.ingested_at                                       AS ingested_at
FROM
(
    SELECT store_id, payload, occurred_at, event_id, ingested_at
    FROM raw_events
    WHERE topic = 'order.placed' AND version IN (1, 2) AND store_id IS NOT NULL
) AS r;
DROP VIEW IF EXISTS mv_orders_minute_v2;
