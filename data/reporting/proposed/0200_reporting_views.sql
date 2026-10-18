-- 0200 reporting views (reporting v1, window 12, issue #478; manager decision 2026-10-16: option C).
-- Five live aggregate views for the Admin API report operations (#479) and the admin BI section (#480).
--
-- Security model: every view is `security_invoker = true`, so a query through a view runs the base tables' row-level
-- security as the CALLER (platform_app with the tenant client's session context), never as the view owner. A store
-- session therefore sees only its own stores' rows even with no WHERE clause; no context sees nothing. No new role, no
-- SECURITY DEFINER function, no materialisation.
--
-- Grain and filters (see data/reporting/README.md):
--   * days are UTC calendar days of the named timestamp (store time zones are a later change);
--   * money is integer minor units beside `currency`; every money view groups by currency, so EUR and GBP are never one
--     sum; sum() of bigint is numeric in Postgres, so each total is cast back to bigint;
--   * sales count an order unless it is cancelled, or its payment is voided or failed ('awaiting' counts: invoice and
--     manual orders are sales until paid or cancelled);
--   * net_minor is cohort-attributed: total_minor minus the order's succeeded refunds, on the order's placement day.
--     rpt_refunds_daily is the cash view of the same refunds, by the day the refund was created;
--   * no column carries an email, name, phone, address, provider reference or idempotency key: counts and ids only.
-- Reads `refund` (window 7's table) read-only.

CREATE VIEW rpt_sales_daily WITH (security_invoker = true) AS
SELECT o.organization_id,
       o.store_id,
       (o.placed_at AT TIME ZONE 'UTC')::date                                AS day,
       o.currency,
       count(*)::bigint                                                       AS orders,
       sum(o.subtotal_minor)::bigint                                          AS gross_minor,
       sum(o.discount_minor)::bigint                                          AS discount_minor,
       sum(o.shipping_minor)::bigint                                          AS shipping_minor,
       sum(o.tax_minor)::bigint                                               AS tax_minor,
       sum(o.total_minor)::bigint                                             AS total_minor,
       coalesce(sum(r.refunded_minor), 0)::bigint                             AS refunded_minor,
       (sum(o.total_minor) - coalesce(sum(r.refunded_minor), 0))::bigint      AS net_minor
FROM "order" o
LEFT JOIN (
  SELECT order_id, sum(amount_minor) AS refunded_minor
  FROM refund
  WHERE status = 'succeeded'
  GROUP BY order_id
) r ON r.order_id = o.id
WHERE o.status <> 'cancelled'
  AND o.payment_status NOT IN ('voided', 'failed')
GROUP BY o.organization_id, o.store_id, (o.placed_at AT TIME ZONE 'UTC')::date, o.currency;

-- fee_minor sums the fees known so far; fee_unknown counts captured payments whose fee is not known yet. Fees stay
-- "unreconciled" until Integration 4 (manager decision on #478).
CREATE VIEW rpt_payments_daily WITH (security_invoker = true) AS
SELECT p.organization_id,
       p.store_id,
       (p.captured_at AT TIME ZONE 'UTC')::date                               AS day,
       p.currency,
       p.provider,
       count(*)::bigint                                                       AS captured_count,
       sum(p.amount_minor)::bigint                                            AS captured_minor,
       coalesce(sum(p.fee_minor), 0)::bigint                                  AS fee_minor,
       count(*) FILTER (WHERE p.fee_minor IS NULL)::bigint                    AS fee_unknown
FROM payment p
WHERE p.status = 'captured'
  AND p.captured_at IS NOT NULL
GROUP BY p.organization_id, p.store_id, (p.captured_at AT TIME ZONE 'UTC')::date, p.currency, p.provider;

CREATE VIEW rpt_refunds_daily WITH (security_invoker = true) AS
SELECT r.organization_id,
       r.store_id,
       (r.created_at AT TIME ZONE 'UTC')::date                                AS day,
       r.currency,
       r.reason,
       count(*)::bigint                                                       AS refunds,
       sum(r.amount_minor)::bigint                                            AS refunded_minor
FROM refund r
WHERE r.status = 'succeeded'
GROUP BY r.organization_id, r.store_id, (r.created_at AT TIME ZONE 'UTC')::date, r.currency, r.reason;

-- The pool has no store: this view follows inventory_level's `pool` kind (a store session sees the rows of items its
-- own variants map, with `reserved` held by every store that maps the item), stock_item's `pool_self` and warehouse's
-- `organization` kind. One row per pool row.
CREATE VIEW rpt_stock_position WITH (security_invoker = true) AS
SELECT il.organization_id,
       il.stock_item_id,
       si.sku,
       il.warehouse_id,
       w.code                                                                 AS warehouse_code,
       il.on_hand,
       il.reserved,
       il.incoming,
       il.available
FROM inventory_level il
JOIN stock_item si ON si.id = il.stock_item_id
JOIN warehouse w ON w.id = il.warehouse_id;

-- Counts only: no column of the customer row is exposed.
CREATE VIEW rpt_customers_daily WITH (security_invoker = true) AS
SELECT c.organization_id,
       c.store_id,
       (c.created_at AT TIME ZONE 'UTC')::date                                AS day,
       count(*)::bigint                                                       AS new_customers,
       count(*) FILTER (WHERE c.status = 'registered')::bigint                AS registered,
       count(*) FILTER (WHERE c.status = 'guest')::bigint                     AS guests
FROM customer c
GROUP BY c.organization_id, c.store_id, (c.created_at AT TIME ZONE 'UTC')::date;

-- Report queries are bounded by day per store; the order view already has order_store_placed_idx (0006).
CREATE INDEX payment_store_captured_idx ON payment (store_id, captured_at) WHERE status = 'captured';
CREATE INDEX refund_store_created_idx ON refund (store_id, created_at) WHERE status = 'succeeded';

-- 0009's default privileges would give platform_app INSERT/UPDATE/DELETE on new relations too: read-only it is.
REVOKE ALL ON rpt_sales_daily, rpt_payments_daily, rpt_refunds_daily, rpt_stock_position, rpt_customers_daily
  FROM PUBLIC, platform_app;
GRANT SELECT ON rpt_sales_daily, rpt_payments_daily, rpt_refunds_daily, rpt_stock_position, rpt_customers_daily
  TO platform_app;
