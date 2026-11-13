-- Facts (#601). One row per business key; money in Int64 minor units beside its currency.

-- fct_order: one row per order (the first order.placed of an order, should a producer ever emit two), from every
-- order.placed version (stg_order_placed: v1 and v2, #696).
-- order_status is the latest of placed / cancelled (a cancellation after a partial shipment still cancels).
-- BI v2 (#871) appends three columns (additive; every earlier column keeps its name, type and place):
--   * sales_channel_id and country (the shipping country: the selling market);
--   * customer_type: `new` for a customer's first order in the store (by placed_at, then the event id — the rule
--     mart_customers_daily uses), `returning` for any later one, `unknown` when the key is NULL (an erased customer,
--     scrubbed by the ingest or the replay). Computed here so no customer key ever leaves the models.
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
        'returning') AS LowCardinality(String))              AS customer_type
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
) AS d;

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
    p.category_id                                            AS category_id
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
        f.customer_type                                                  AS customer_type
    FROM stg_order_placed AS o
    INNER JOIN fct_order AS f ON f.source_event_id = o.event_id
    ARRAY JOIN o.line_items AS li
) AS l
LEFT JOIN dim_variant AS v ON v.store_id = l.store_id AND v.variant_id = l.variant_key
LEFT JOIN dim_product AS p ON p.store_id = l.store_id AND p.product_id = v.product_id;

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
LEFT JOIN fct_order AS o ON o.order_id = r.order_id;

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
ARRAY JOIN items AS it;

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
FROM stg_return_received_v1 AS r
INNER JOIN fct_order_line AS l ON l.order_line_item_id = r.order_line_item_id;
