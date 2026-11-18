-- Marts (#601): organization × store × currency × UTC day. Nothing is summed across currencies.
-- mart_recognised_daily was DROPPED (manager 2026-10-25): recognised revenue comes from the ledger's own posted
-- lines in #602, never a recomputation here (D7).
-- Every view with a JOIN ends with SETTINGS join_algorithm = 'hash' (BI v2, #871 f): ClickHouse 25.8's default
-- parallel hash join preallocates ~300 MiB per query whatever the data size (fct_order_line on the generated month:
-- 309 MiB → 4.4 MiB), and the shared server's memory cap is ~1.1 GiB. A view's SETTINGS apply when it is read.

-- mart_bookings_daily: the same rules and columns as Postgres rpt_sales_daily (packages/db 0200), so #602 can
-- compare them row for row: orders by placement day, excluding cancelled orders and orders whose payment failed
-- (and never captured); refunds are cohort-attributed to the order's placement day.
CREATE OR REPLACE VIEW mart_bookings_daily AS
SELECT
    o.organization_id                                              AS organization_id,
    o.store_id                                                     AS store_id,
    toDate(o.placed_at, 'UTC')                                     AS day,
    o.currency                                                     AS currency,
    count()                                                        AS orders,
    sum(o.subtotal_minor)                                          AS gross_minor,
    sum(o.discount_minor)                                          AS discount_minor,
    sum(o.shipping_minor)                                          AS shipping_minor,
    sum(o.tax_minor)                                               AS tax_minor,
    sum(o.total_minor)                                             AS total_minor,
    coalesce(sum(r.refunded_minor), 0)                             AS refunded_minor,
    sum(o.total_minor) - coalesce(sum(r.refunded_minor), 0)        AS net_minor
FROM fct_order AS o
LEFT JOIN
(
    SELECT order_id, sum(amount_minor) AS refunded_minor FROM fct_refund GROUP BY order_id
) AS r ON r.order_id = o.order_id
WHERE o.order_status != 'cancelled'
  AND o.order_id NOT IN
  (
      SELECT order_id FROM fct_payment
      WHERE status = 'failed'
        AND order_id NOT IN (SELECT order_id FROM fct_payment WHERE status = 'captured')
  )
GROUP BY organization_id, store_id, day, currency
SETTINGS join_algorithm = 'hash';

-- mart_cash_daily: the same rules and columns as Postgres rpt_payments_daily: captures by capture day and provider,
-- known fees summed, unknown fees counted (fee_minor is NULL until the PSP reports it).
CREATE OR REPLACE VIEW mart_cash_daily AS
SELECT
    organization_id,
    store_id,
    toDate(at, 'UTC')                    AS day,
    currency,
    provider,
    count()                              AS captured_count,
    sum(amount_minor)                    AS captured_minor,
    coalesce(sum(fee), 0)                AS fee_minor,
    countIf(isNull(fee))                 AS fee_unknown
FROM
(
    -- the source column is renamed so the output alias fee_minor cannot shadow it inside countIf
    SELECT organization_id, store_id, at, currency, provider, amount_minor, fee_minor AS fee
    FROM fct_payment
    WHERE status = 'captured'
)
GROUP BY organization_id, store_id, day, currency, provider;

-- mart_customers_daily (#603 new / returning, #623 erasure-aware): per store × UTC day, counts only.
--   * a customer is `new` on the day of their FIRST order in that store (by placed_at, then the event id) and
--     `returning` on any day they order again; each counted once per day;
--   * an order whose customer_key is NULL (an erased customer, scrubbed by the ingest) counts in `unknown_orders`:
--     its money stays in every money mart, but it belongs to nobody here.
-- No customer key ever leaves this view.
CREATE OR REPLACE VIEW mart_customers_daily AS
WITH firsts AS
(
    SELECT store_id, customer_key, min((placed_at, toString(source_event_id))) AS first_order
    FROM fct_order
    WHERE customer_key IS NOT NULL
    GROUP BY store_id, customer_key
)
SELECT
    o.organization_id                                                              AS organization_id,
    o.store_id                                                                     AS store_id,
    toDate(o.placed_at, 'UTC')                                                     AS day,
    uniqExactIf(o.customer_key, o.customer_key IS NOT NULL
                AND (o.placed_at, toString(o.source_event_id)) = f.first_order)         AS new_customers,
    uniqExactIf(o.customer_key, o.customer_key IS NOT NULL
                AND (o.placed_at, toString(o.source_event_id)) != f.first_order)        AS returning_customers,
    countIf(o.customer_key IS NULL)                                                AS unknown_orders
FROM fct_order AS o
LEFT JOIN firsts AS f ON f.store_id = o.store_id AND f.customer_key = o.customer_key
GROUP BY organization_id, store_id, day
SETTINGS join_algorithm = 'hash';

-- mart_sales_daily (BI v2, #871): mart_bookings_daily's figures with the keys country, sales_channel_id and
-- customer_type, plus the cancelled and placed counts the cancellation rate needs. mart_bookings_daily stays as it is
-- (the reconcile identity 1 compares it row for row with the core): summed over the new keys, this mart equals it.
-- Failed-only orders are out, as there; cancelled orders count only in cancelled_orders and placed_orders.
CREATE OR REPLACE VIEW mart_sales_daily AS
SELECT
    o.organization_id                                                              AS organization_id,
    o.store_id                                                                     AS store_id,
    toDate(o.placed_at, 'UTC')                                                     AS day,
    o.currency                                                                     AS currency,
    o.country                                                                      AS country,
    o.sales_channel_id                                                             AS sales_channel_id,
    o.customer_type                                                                AS customer_type,
    countIf(o.order_status != 'cancelled')                                         AS orders,
    sumIf(o.subtotal_minor, o.order_status != 'cancelled')                         AS gross_minor,
    sumIf(o.discount_minor, o.order_status != 'cancelled')                         AS discount_minor,
    sumIf(o.shipping_minor, o.order_status != 'cancelled')                         AS shipping_minor,
    sumIf(o.tax_minor, o.order_status != 'cancelled')                              AS tax_minor,
    sumIf(o.total_minor, o.order_status != 'cancelled')                            AS total_minor,
    sumIf(coalesce(r.refunded_minor, 0), o.order_status != 'cancelled')            AS refunded_minor,
    sumIf(o.total_minor - coalesce(r.refunded_minor, 0), o.order_status != 'cancelled') AS net_minor,
    countIf(o.order_status = 'cancelled')                                          AS cancelled_orders,
    count()                                                                        AS placed_orders
FROM fct_order AS o
LEFT JOIN
(
    SELECT order_id, sum(amount_minor) AS refunded_minor FROM fct_refund GROUP BY order_id
) AS r ON r.order_id = o.order_id
WHERE o.order_id NOT IN
  (
      SELECT order_id FROM fct_payment
      WHERE status = 'failed'
        AND order_id NOT IN (SELECT order_id FROM fct_payment WHERE status = 'captured')
  )
GROUP BY organization_id, store_id, day, currency, country, sales_channel_id, customer_type
SETTINGS join_algorithm = 'hash';

-- mart_stock_daily (BI v2, #871): stock movements per warehouse × stock item × UTC day. Before the pool (#456,
-- stock.moved v1) a movement has no stock item: it is keyed by its variant (legacy_variant_id) instead.
--   * stockout_events: movements that took on-hand from above 0 to 0 or below (a transition, not every movement
--     while empty);
--   * units_received: receipts and transfers in (positive deltas);
--   * units_adjusted: adjustments and cycle counts (signed);
--   * on_hand_end: on-hand after the day's last movement.
-- store_id is the store that caused the movement (NULL for organization-level movements): a store caller sees its
-- own store's movements only. The CURRENT position is never read from here (reservations are not movements).
CREATE OR REPLACE VIEW mart_stock_daily AS
SELECT
    organization_id,
    movement_store_id                                                    AS store_id,
    warehouse_id,
    stock_item_id,
    if(stock_item_id IS NULL, variant_id, CAST(NULL AS Nullable(UUID)))  AS legacy_variant_id,
    toDate(occurred_at, 'UTC')                                           AS day,
    countIf(on_hand_after <= 0 AND on_hand_after - delta > 0)            AS stockout_events,
    sumIf(delta, reason IN ('receipt', 'transfer_in') AND delta > 0)     AS units_received,
    sumIf(delta, reason IN ('adjustment', 'cycle_count'))                AS units_adjusted,
    argMax(on_hand_after, (occurred_at, toString(stock_movement_id)))    AS on_hand_end,
    count()                                                              AS movements
FROM stg_stock_moved
GROUP BY organization_id, store_id, warehouse_id, stock_item_id, legacy_variant_id, day;
