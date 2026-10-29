-- Facts (#601). One row per business key; money in Int64 minor units beside its currency.

-- fct_order: one row per order (the first order.placed of an order, should a producer ever emit two).
-- order_status is the latest of placed / cancelled (a cancellation after a partial shipment still cancels).
CREATE OR REPLACE VIEW fct_order AS
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
         AS LowCardinality(String))                          AS order_status,
    event_id                                                 AS source_event_id
FROM stg_order_placed_v1
ORDER BY occurred_at, event_id
LIMIT 1 BY order_id;

-- fct_order_line: the BINDING interface window 9 reads (#601 manager decision 2026-10-25; additive changes only
-- after #601 merges). Grain: order_line_item_id. product_id via dim_variant; NULL when the variant was never
-- published (or the line has no variant).
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
    l.source_event_id                                        AS source_event_id
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
        o.event_id                                                       AS source_event_id
    FROM stg_order_placed_v1 AS o
    INNER JOIN fct_order AS f ON f.source_event_id = o.event_id
    ARRAY JOIN o.line_items AS li
) AS l
LEFT JOIN dim_variant AS v ON v.store_id = l.store_id AND v.variant_id = l.variant_key;

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
CREATE OR REPLACE VIEW fct_refund AS
SELECT
    organization_id, store_id, refund_id, payment_id, order_id, legal_entity_id,
    amount_minor, currency, reason, issued_at,
    event_id AS source_event_id
FROM stg_refund_issued_v1;

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
