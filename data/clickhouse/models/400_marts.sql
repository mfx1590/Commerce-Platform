-- Marts (#601): organization × store × currency × UTC day. Nothing is summed across currencies.
-- mart_recognised_daily was DROPPED (manager 2026-10-25): recognised revenue comes from the ledger's own posted
-- lines in #602, never a recomputation here (D7).

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
GROUP BY organization_id, store_id, day, currency;

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
