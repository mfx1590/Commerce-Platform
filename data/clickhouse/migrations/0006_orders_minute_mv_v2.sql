-- #689: replace mv_orders_minute (0002), whose NULL filter was a no-op. It selected
-- `assumeNotNull(store_id) AS store_id … WHERE … store_id IS NOT NULL`, and in ClickHouse the WHERE reads the
-- ALIAS (never NULL), so an order.placed without a store would land under the zero uuid. order.placed is always
-- store-scoped (packages/events), so this has had no row to let through; the guard is made real anyway.
--
-- In this order, so nothing is lost or counted twice:
--   1. the new MV, filtering in a subquery (no alias can shadow a filtered column). From here both MVs write every
--      insert; copies fold (same ReplacingMergeTree key) and the tile reads FINAL.
--   2. the old MV dropped. An insert already running keeps the views it began with, so it still writes through the
--      old one; inserts that start later see only the new one.
--   3. the zero-uuid store rows deleted. The runner first waits for every insert running at that moment (the ones
--      that could still write through the old MV), so none can add such a row after the delete.
-- No backfill: the new MV takes over from the old one with no gap, and the table already holds every event.
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_orders_minute_v2 TO orders_minute_events AS
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
    WHERE topic = 'order.placed' AND version = 1 AND store_id IS NOT NULL
) AS r;
DROP VIEW IF EXISTS mv_orders_minute;
DELETE FROM orders_minute_events WHERE store_id = toUUID('00000000-0000-0000-0000-000000000000');
