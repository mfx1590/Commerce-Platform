-- Live tiles (#601, D6): what the metrics API polls every 15 s. Reads the per-event rows mv_orders_minute_v3 writes
-- (migrations/0007: order.placed v1 and v2; 0002 and 0006 before it) through FINAL, so a redelivered event counts once; orders are counted exactly (uniqExact, never
-- the approximate uniq), and totals are summed per currency only.
CREATE OR REPLACE VIEW live_orders_minute AS
SELECT
    store_id,
    currency,
    minute,
    uniqExact(order_id)   AS orders,
    sum(total_minor)      AS total_minor
FROM orders_minute_events FINAL
GROUP BY store_id, currency, minute;
