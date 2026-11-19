-- Facts (#601). One row per business key; money in Int64 minor units beside its currency.
-- Every view with a JOIN ends with SETTINGS join_algorithm = 'hash' (BI v2, #871 f): ClickHouse 25.8's default
-- parallel hash join preallocates ~300 MiB per query whatever the data size (fct_order_line on the generated month:
-- 309 MiB → 4.4 MiB), and the shared server's memory cap is ~1.1 GiB. A view's SETTINGS apply when it is read.

-- fct_order: one row per order (the first order.placed of an order, should a producer ever emit two), from every
-- order.placed version (stg_order_placed: v1 and v2, #696).
-- order_status is the latest of placed / cancelled (a cancellation after a partial shipment still cancels).
-- BI v2 (#871) appends three columns (additive; every earlier column keeps its name, type and place):
--   * sales_channel_id and country (the shipping country: the selling market);
--   * customer_type: `new` for a customer's first order in the store (by placed_at, then the event id — the rule
--     mart_customers_daily uses), `returning` for any later one, `unknown` when the key is NULL (an erased customer,
--     scrubbed by the ingest or the replay). Computed here so no customer key ever leaves the models.
-- BI v2 wave 2 (#935) appends customer_group_id: the customer's CURRENT group from dim_customer (no history).
CREATE OR REPLACE VIEW fct_order AS
SELECT
    d.organization_id                                        AS organization_id,
    d.store_id                                               AS store_id,
    d.order_id                                               AS order_id,
    d.display_id                                             AS display_id,
    d.legal_entity_id                                        AS legal_entity_id,
    d.currency                                               AS currency,
    d.customer_key                                           AS customer_key,
    d.subtotal_minor                                         AS subtotal_minor,
    d.discount_minor                                         AS discount_minor,
    d.shipping_minor                                         AS shipping_minor,
    d.tax_minor                                              AS tax_minor,
    d.total_minor                                            AS total_minor,
    d.placed_at                                              AS placed_at,
    d.order_status                                           AS order_status,
    d.source_event_id                                        AS source_event_id,
    d.sales_channel_id                                       AS sales_channel_id,
    CAST(d.shipping_country AS LowCardinality(String))       AS country,
    CAST(multiIf(
        d.customer_key IS NULL, 'unknown',
        row_number() OVER (PARTITION BY d.store_id, d.customer_key
                           ORDER BY d.placed_at, toString(d.source_event_id)) = 1, 'new',
        'returning') AS LowCardinality(String))              AS customer_type,
    -- BI v2 wave 2 (#935): the customer's CURRENT group (dim_customer), NULL for no group or no key
    c.customer_group_id                                      AS customer_group_id
FROM
(
    SELECT
        organization_id,
        store_id,
        order_id,
        display_id,
        legal_entity_id,
        currency,
        customer_key,
        subtotal_minor,
        discount_minor,
        shipping_minor,
        tax_minor,
        total_minor,
        placed_at,
        CAST(if(order_id IN (SELECT order_id FROM stg_order_cancelled_v1), 'cancelled', 'placed')
             AS LowCardinality(String))                      AS order_status,
        event_id                                             AS source_event_id,
        sales_channel_id,
        shipping_country
    FROM stg_order_placed
    ORDER BY occurred_at, event_id
    LIMIT 1 BY order_id
) AS d
LEFT JOIN dim_customer AS c ON c.store_id = d.store_id AND c.customer_key = d.customer_key
SETTINGS join_algorithm = 'hash';

-- fct_order_line: the BINDING interface window 9 reads (#601 manager decision 2026-10-25; additive changes only
-- after #601 merges). Grain: order_line_item_id. product_id via dim_variant; NULL when the variant was never
-- published (or the line has no variant). BI v2 (#871) appends the order's sales_channel_id, country and
-- customer_type, and the product's category_id (dim_product: as of its last publish until #876).
CREATE OR REPLACE VIEW fct_order_line AS
SELECT
    l.organization_id                                        AS organization_id,
    l.store_id                                               AS store_id,
    l.order_id                                               AS order_id,
    l.order_line_item_id                                     AS order_line_item_id,
    l.variant_id_in                                          AS variant_id,
    if(v.variant_id = toUUID('00000000-0000-0000-0000-000000000000'),
       CAST(NULL AS Nullable(UUID)),
       CAST(v.product_id AS Nullable(UUID)))                 AS product_id,
    l.sku                                                    AS sku,
    l.quantity                                               AS quantity,
    l.unit_price_minor                                       AS unit_price_minor,
    l.discount_minor                                         AS discount_minor,
    l.tax_minor                                              AS tax_minor,
    l.total_minor                                            AS total_minor,
    l.currency                                               AS currency,
    l.placed_at                                              AS placed_at,
    l.order_status                                           AS order_status,
    l.source_event_id                                        AS source_event_id,
    l.sales_channel_id                                       AS sales_channel_id,
    l.country                                                AS country,
    l.customer_type                                          AS customer_type,
    p.category_id                                            AS category_id,
    l.customer_group_id                                      AS customer_group_id
FROM
(
    SELECT
        o.organization_id                                                AS organization_id,
        o.store_id                                                       AS store_id,
        o.order_id                                                       AS order_id,
        toUUID(JSONExtractString(li, 'order_line_item_id'))              AS order_line_item_id,
        toUUIDOrNull(JSONExtract(li, 'variant_id', 'Nullable(String)'))  AS variant_id_in,
        ifNull(
            toUUIDOrNull(JSONExtract(li, 'variant_id', 'Nullable(String)')),
            toUUID('00000000-0000-0000-0000-000000000000')
        )                                                                AS variant_key,
        JSONExtractString(li, 'sku')                                     AS sku,
        toUInt32(JSONExtractInt(li, 'quantity'))                         AS quantity,
        JSONExtractInt(li, 'unit_price_minor')                           AS unit_price_minor,
        JSONExtractInt(li, 'discount_minor')                             AS discount_minor,
        JSONExtractInt(li, 'tax_minor')                                  AS tax_minor,
        JSONExtractInt(li, 'total_minor')                                AS total_minor,
        o.currency                                                       AS currency,
        o.placed_at                                                      AS placed_at,
        f.order_status                                                   AS order_status,
        o.event_id                                                       AS source_event_id,
        f.sales_channel_id                                               AS sales_channel_id,
        f.country                                                        AS country,
        f.customer_type                                                  AS customer_type,
        f.customer_group_id                                              AS customer_group_id
    FROM stg_order_placed AS o
    INNER JOIN fct_order AS f ON f.source_event_id = o.event_id
    ARRAY JOIN o.line_items AS li
) AS l
LEFT JOIN dim_variant AS v ON v.store_id = l.store_id AND v.variant_id = l.variant_key
LEFT JOIN dim_product AS p ON p.store_id = l.store_id AND p.product_id = v.product_id
SETTINGS join_algorithm = 'hash';

-- fct_payment: one row per payment and outcome (captured, failed).
CREATE OR REPLACE VIEW fct_payment AS
SELECT
    organization_id, store_id, payment_id, order_id, provider,
    CAST('captured' AS LowCardinality(String))   AS status,
    amount_minor, fee_minor, currency,
    captured_at                                  AS at,
    event_id                                     AS source_event_id
FROM stg_payment_captured_v1
UNION ALL
SELECT
    organization_id, store_id, payment_id, order_id, provider,
    CAST('failed' AS LowCardinality(String))     AS status,
    amount_minor, CAST(NULL AS Nullable(Int64))  AS fee_minor, currency,
    failed_at                                    AS at,
    event_id                                     AS source_event_id
FROM stg_payment_failed_v1;

-- fct_refund: one row per succeeded refund (refund.issued).
-- BI v2 (#871) appends the refunded order's country and sales_channel_id ('' / NULL until the order is in the facts):
-- refunds take the same dimensions as the sales they reduce. One fct_order row per order, so no refund is repeated.
CREATE OR REPLACE VIEW fct_refund AS
SELECT
    r.organization_id                                        AS organization_id,
    r.store_id                                               AS store_id,
    r.refund_id                                              AS refund_id,
    r.payment_id                                             AS payment_id,
    r.order_id                                               AS order_id,
    r.legal_entity_id                                        AS legal_entity_id,
    r.amount_minor                                           AS amount_minor,
    r.currency                                               AS currency,
    r.reason                                                 AS reason,
    r.issued_at                                              AS issued_at,
    r.event_id                                               AS source_event_id,
    o.country                                                AS country,
    o.sales_channel_id                                       AS sales_channel_id
FROM stg_refund_issued_v1 AS r
LEFT JOIN fct_order AS o ON o.order_id = r.order_id
SETTINGS join_algorithm = 'hash';

-- fct_shipment_line: one row per (shipment, order line): what left the warehouse, for lineage and the lifetime
-- invariant of #602. Shipment cost stays on the shipment, not on its lines. No posting rule is encoded here (D7).
CREATE OR REPLACE VIEW fct_shipment_line AS
SELECT
    organization_id,
    store_id,
    shipment_id,
    order_id,
    legal_entity_id,
    warehouse_id,
    toUUID(JSONExtractString(it, 'order_line_item_id'))  AS order_line_item_id,
    toUInt32(JSONExtractInt(it, 'quantity'))             AS quantity,
    shipped_at,
    event_id                                             AS source_event_id
FROM stg_shipment_shipped_v1
ARRAY JOIN items AS it
SETTINGS join_algorithm = 'hash';

-- fct_return_line (BI v2, #871): one row per returned line (return.received), attributed through its order line to
-- the product, category, store, currency, country, channel and customer type of the sale. A return whose order line
-- is not (yet) in the facts is left out until it is: the inner join, stated, not a silent zero.
CREATE OR REPLACE VIEW fct_return_line AS
SELECT
    r.organization_id                                        AS organization_id,
    l.store_id                                               AS store_id,
    r.return_id                                              AS return_id,
    r.order_id                                               AS order_id,
    r.order_line_item_id                                     AS order_line_item_id,
    r.warehouse_id                                           AS warehouse_id,
    r.quantity                                               AS quantity,
    r.condition                                              AS condition,
    r.received_at                                            AS received_at,
    l.product_id                                             AS product_id,
    l.category_id                                            AS category_id,
    l.currency                                               AS currency,
    l.country                                                AS country,
    l.sales_channel_id                                       AS sales_channel_id,
    l.customer_type                                          AS customer_type,
    r.event_id                                               AS source_event_id
-- The returns are the RIGHT side (ClickHouse holds the right side of a join in memory: the few returned lines, never
-- every order line), and the order lines are narrowed to the returned ones first.
FROM
(
    SELECT * FROM fct_order_line
    WHERE order_line_item_id IN (SELECT order_line_item_id FROM stg_return_received_v1)
) AS l
INNER JOIN stg_return_received_v1 AS r ON r.order_line_item_id = l.order_line_item_id
SETTINGS join_algorithm = 'hash';

-- ---- BI v2 wave 2 (#935) -------------------------------------------------------------------------------------------
-- fct_order_sales: one row per order COUNTED in sales, with mart_sales_daily's rules exactly (cancelled orders and
-- failed-only orders are out; net = total − refunds). Customers and attribution read it, so their net sales are the
-- sales figures' net sales. customer_key stays inside the models (counted, never returned).
CREATE OR REPLACE VIEW fct_order_sales AS
SELECT
    o.organization_id                                        AS organization_id,
    o.store_id                                               AS store_id,
    o.order_id                                               AS order_id,
    o.placed_at                                              AS placed_at,
    o.currency                                               AS currency,
    o.country                                                AS country,
    o.sales_channel_id                                       AS sales_channel_id,
    o.customer_type                                          AS customer_type,
    o.customer_group_id                                      AS customer_group_id,
    o.customer_key                                           AS customer_key,
    o.total_minor - coalesce(r.refunded_minor, 0)            AS net_minor,
    -- the key's FIRST order in the store (any status: mart_customers_daily's rule), for cohorts; NULL without a key
    f.first_order_at                                         AS first_order_at
FROM fct_order AS o
LEFT JOIN
(
    SELECT order_id, sum(amount_minor) AS refunded_minor FROM fct_refund GROUP BY order_id
) AS r ON r.order_id = o.order_id
LEFT JOIN
(
    SELECT store_id, customer_key, min(placed_at) AS first_order_at
    FROM fct_order WHERE customer_key IS NOT NULL GROUP BY store_id, customer_key
) AS f ON f.store_id = o.store_id AND f.customer_key = o.customer_key
WHERE o.order_status != 'cancelled'
  AND o.order_id NOT IN
  (
      SELECT order_id FROM fct_payment
      WHERE status = 'failed'
        AND order_id NOT IN (SELECT order_id FROM fct_payment WHERE status = 'captured')
  )
SETTINGS join_algorithm = 'hash', join_use_nulls = 1;

-- fct_order_touch: every counted order TWICE, once per touch model (first, last), with that touch's utm values and
-- campaign, or none (attributed = 0). An order with several events for one touch keeps the earliest recorded.
-- in_campaign = 1 when the order was placed inside its campaign's [starts_at, ends_at] (an open end counts).
CREATE OR REPLACE VIEW fct_order_touch AS
SELECT
    o.organization_id                                        AS organization_id,
    o.store_id                                               AS store_id,
    o.order_id                                               AS order_id,
    o.placed_at                                              AS placed_at,
    o.currency                                               AS currency,
    o.net_minor                                              AS net_minor,
    o.touch_model                                            AS touch,
    toUInt8(a.order_id IS NOT NULL)                          AS attributed,
    a.utm_source                                             AS utm_source,
    a.utm_medium                                             AS utm_medium,
    a.utm_campaign                                           AS utm_campaign,
    a.campaign_id                                            AS campaign_id,
    toUInt8(a.campaign_id IS NOT NULL
            AND (k.starts_at IS NULL OR o.placed_at >= k.starts_at)
            AND (k.ends_at IS NULL OR o.placed_at <= k.ends_at)) AS in_campaign
FROM
(
    SELECT *, touch_model FROM fct_order_sales ARRAY JOIN ['first', 'last'] AS touch_model
) AS o
LEFT JOIN
(
    SELECT order_id, toString(touch) AS touch, utm_source, utm_medium, utm_campaign, campaign_id
    FROM stg_attribution_v1
    ORDER BY occurred_at, event_id
    LIMIT 1 BY order_id, touch
) AS a ON a.order_id = o.order_id AND a.touch = o.touch_model
LEFT JOIN dim_campaign AS k ON k.store_id = o.store_id AND k.campaign_id = a.campaign_id
SETTINGS join_algorithm = 'hash', join_use_nulls = 1;

-- fct_shipment: one row per shipment known from shipment.created or shipment.shipped, with its warehouse and carrier
-- (from either), destination_country (created only), cost and shipped_at (shipped only), delivered_at (delivered).
CREATE OR REPLACE VIEW fct_shipment AS
SELECT
    any(u.organization_id)                                   AS organization_id,
    any(u.store_id)                                          AS store_id,
    u.shipment_id                                            AS shipment_id,
    any(u.order_id)                                          AS order_id,
    anyIf(u.in_warehouse_id, u.in_warehouse_id IS NOT NULL)  AS warehouse_id,
    anyIf(u.in_carrier, u.in_carrier != '')                  AS carrier,
    anyIf(u.in_country, u.in_country != '')                  AS destination_country,
    minIf(u.in_created_at, u.in_created_at IS NOT NULL)      AS created_at,
    minIf(u.in_shipped_at, u.in_shipped_at IS NOT NULL)      AS shipped_at,
    anyIf(u.in_cost_minor, u.in_shipped_at IS NOT NULL)      AS cost_minor,
    anyIf(u.in_currency, u.in_currency != '')                AS currency,
    maxIf(u.in_delivered_at, u.in_delivered_at IS NOT NULL)  AS delivered_at
FROM
(
    SELECT organization_id, store_id, shipment_id, order_id,
           CAST(warehouse_id AS Nullable(UUID))                       AS in_warehouse_id,
           toString(carrier)                                          AS in_carrier,
           destination_country                                        AS in_country,
           CAST(occurred_at AS Nullable(DateTime64(3, 'UTC')))        AS in_created_at,
           CAST(NULL AS Nullable(DateTime64(3, 'UTC')))               AS in_shipped_at,
           CAST(NULL AS Nullable(Int64))                              AS in_cost_minor,
           ''                                                         AS in_currency,
           CAST(NULL AS Nullable(DateTime64(3, 'UTC')))               AS in_delivered_at
    FROM stg_shipment_created_v1
    UNION ALL
    SELECT organization_id, store_id, shipment_id, order_id,
           CAST(warehouse_id AS Nullable(UUID)), lower(carrier), '',
           CAST(NULL AS Nullable(DateTime64(3, 'UTC'))),
           CAST(shipped_at AS Nullable(DateTime64(3, 'UTC'))), cost_minor, currency,
           CAST(NULL AS Nullable(DateTime64(3, 'UTC')))
    FROM stg_shipment_shipped_v1
    UNION ALL
    SELECT organization_id, store_id, shipment_id, order_id,
           CAST(NULL AS Nullable(UUID)), '', '',
           CAST(NULL AS Nullable(DateTime64(3, 'UTC'))), CAST(NULL AS Nullable(DateTime64(3, 'UTC'))),
           CAST(NULL AS Nullable(Int64)), '',
           CAST(delivered_at AS Nullable(DateTime64(3, 'UTC')))
    FROM stg_shipment_delivered_v1
) AS u
GROUP BY u.shipment_id;

-- fct_order_fulfilment: one row per order with at least one shipment. hours_to_ship = placement → the FIRST shipment
-- that left; hours_to_deliver = placement → the LAST delivery, set only when EVERY shipment of the order is delivered
-- (an order still in transit has none: it is excluded from time to deliver, and shows in the backlog). The warehouse
-- and carrier are the first shipped shipment's (else the first created one's).
CREATE OR REPLACE VIEW fct_order_fulfilment AS
SELECT
    o.organization_id                                        AS organization_id,
    o.store_id                                               AS store_id,
    o.order_id                                               AS order_id,
    o.placed_at                                              AS placed_at,
    s.warehouse_id                                           AS warehouse_id,
    s.carrier                                                AS carrier,
    s.first_shipped_at                                       AS first_shipped_at,
    if(s.shipments = s.delivered, s.last_delivered_at, NULL) AS delivered_at,
    if(s.first_shipped_at IS NULL, NULL,
       dateDiff('second', o.placed_at, s.first_shipped_at) / 3600.0) AS hours_to_ship,
    if(s.shipments = s.delivered AND s.last_delivered_at IS NOT NULL,
       dateDiff('second', o.placed_at, s.last_delivered_at) / 3600.0, NULL) AS hours_to_deliver
FROM fct_order AS o
INNER JOIN
(
    SELECT
        order_id,
        argMinIf(warehouse_id, coalesce(shipped_at, created_at), warehouse_id IS NOT NULL) AS warehouse_id,
        argMinIf(carrier, coalesce(shipped_at, created_at), carrier != '')                 AS carrier,
        minIf(shipped_at, shipped_at IS NOT NULL)                                          AS first_shipped_at,
        maxIf(delivered_at, delivered_at IS NOT NULL)                                      AS last_delivered_at,
        count()                                                                            AS shipments,
        countIf(delivered_at IS NOT NULL)                                                  AS delivered
    FROM fct_shipment
    GROUP BY order_id
) AS s ON s.order_id = o.order_id
WHERE o.order_status != 'cancelled'
SETTINGS join_algorithm = 'hash', join_use_nulls = 1;

-- fct_payment_event: every payment outcome event (authorized, captured, failed) with the normalised failure code.
-- Metrics count DISTINCT payment_id per outcome: a payment retried after a failure counts once as failed.
CREATE OR REPLACE VIEW fct_payment_event AS
SELECT organization_id, store_id, payment_id, order_id, provider,
       CAST('authorized' AS LowCardinality(String)) AS outcome, CAST('' AS LowCardinality(String)) AS failure_code,
       authorized_at AS at
FROM stg_payment_authorized_v1
UNION ALL
SELECT organization_id, store_id, payment_id, order_id, provider,
       CAST('captured' AS LowCardinality(String)), CAST('' AS LowCardinality(String)), captured_at
FROM stg_payment_captured_v1
UNION ALL
SELECT organization_id, store_id, payment_id, order_id, provider,
       CAST('failed' AS LowCardinality(String)), failure_code, failed_at
FROM stg_payment_failure_v1;
