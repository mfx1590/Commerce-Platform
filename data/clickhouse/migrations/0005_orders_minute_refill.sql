-- #685: repair for databases where 0002 ran while the ingest was inserting. An insert that began before
-- mv_orders_minute existed and committed after 0002's backfill had read raw_events reached neither, so its
-- order.placed rows were missing from orders_minute_events for good (raw_events, the truth, kept them all).
--
-- The runner now waits for every INSERT running on the database before any backfill (migrations.ts), so this
-- refill sees every row such an insert wrote; it fills only the event_ids still missing, and copies would fold
-- anyway (same key, ReplacingMergeTree). On a fresh database it finds nothing to add. The rows are filtered in a
-- subquery first, so no alias of the projection (assumeNotNull(store_id) AS store_id) can shadow a filtered column.
INSERT INTO orders_minute_events
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
    FROM raw_events FINAL
    WHERE topic = 'order.placed' AND version = 1 AND store_id IS NOT NULL
      AND event_id NOT IN (SELECT event_id FROM orders_minute_events)
) AS r;
