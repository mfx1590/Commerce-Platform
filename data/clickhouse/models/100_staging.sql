-- Staging (#601): one view per topic version the facts read, typed columns out of raw_events.payload.
-- Every view reads raw_events FINAL, so a redelivered event appears once. The filters sit in the subquery, where no
-- output alias exists (`assumeNotNull(store_id) AS store_id` would otherwise turn `store_id IS NOT NULL` into a
-- no-op: the alias-shadow class, sql-lint.ts). Envelope columns first, then the payload's.
-- No PII: customer_id and titles are left out; email_hash is kept only as order.placed's `customer_key` (#623, the
-- erasure-aware pseudonymous key for new vs returning customers).
-- Money is Int64 minor units beside its currency.

CREATE OR REPLACE VIEW stg_order_placed_v1 AS
SELECT
    event_id,
    organization_id,
    assumeNotNull(store_id)                                                AS store_id,
    occurred_at,
    toUUID(JSONExtractString(payload, 'order_id'))                         AS order_id,
    JSONExtractInt(payload, 'display_id')                                  AS display_id,
    toUUID(JSONExtractString(payload, 'legal_entity_id'))                  AS legal_entity_id,
    JSONExtractString(payload, 'currency')                                 AS currency,
    -- BI v2 (#871): the selling market and channel; required on every order.placed version
    toUUIDOrNull(JSONExtractString(payload, 'sales_channel_id'))           AS sales_channel_id,
    JSONExtractString(payload, 'shipping_country')                         AS shipping_country,
    JSONExtractString(payload, 'billing_country')                          AS billing_country,
    JSONExtractString(payload, 'locale')                                   AS locale,
    -- #623: the pseudonymous customer key (email_hash); NULL once the customer is erased (the ingest scrubs it). Used
    -- only inside models (new vs returning); no operation ever returns it.
    nullIf(JSONExtractString(payload, 'email_hash'), '')                   AS customer_key,
    JSONExtractInt(payload, 'totals', 'subtotal_minor')                    AS subtotal_minor,
    JSONExtractInt(payload, 'totals', 'discount_minor')                    AS discount_minor,
    JSONExtractInt(payload, 'totals', 'shipping_minor')                    AS shipping_minor,
    JSONExtractInt(payload, 'totals', 'tax_minor')                         AS tax_minor,
    JSONExtractInt(payload, 'totals', 'total_minor')                       AS total_minor,
    JSONExtractArrayRaw(payload, 'line_items')                             AS line_items,
    parseDateTime64BestEffort(JSONExtractString(payload, 'placed_at'), 3, 'UTC') AS placed_at
FROM (SELECT * FROM raw_events FINAL WHERE topic = 'order.placed' AND version = 1 AND store_id IS NOT NULL);

-- order.placed v2 (#696): v1 with email_hash nullable, nothing else. A null hash is an erased customer (the outbox
-- replay scrubs it before republishing); the order and its money are still the ledger's, so it is staged like v1
-- and its customer_key is NULL: counted in mart_customers_daily.unknown_orders, never joined (no join on NULL).
CREATE OR REPLACE VIEW stg_order_placed_v2 AS
SELECT
    event_id,
    organization_id,
    assumeNotNull(store_id)                                                AS store_id,
    occurred_at,
    toUUID(JSONExtractString(payload, 'order_id'))                         AS order_id,
    JSONExtractInt(payload, 'display_id')                                  AS display_id,
    toUUID(JSONExtractString(payload, 'legal_entity_id'))                  AS legal_entity_id,
    JSONExtractString(payload, 'currency')                                 AS currency,
    -- BI v2 (#871): the selling market and channel; required on every order.placed version
    toUUIDOrNull(JSONExtractString(payload, 'sales_channel_id'))           AS sales_channel_id,
    JSONExtractString(payload, 'shipping_country')                         AS shipping_country,
    JSONExtractString(payload, 'billing_country')                          AS billing_country,
    JSONExtractString(payload, 'locale')                                   AS locale,
    -- NULL when the replay scrubbed an erased customer (v2's only change) or the ingest did (#623)
    nullIf(JSONExtractString(payload, 'email_hash'), '')                   AS customer_key,
    JSONExtractInt(payload, 'totals', 'subtotal_minor')                    AS subtotal_minor,
    JSONExtractInt(payload, 'totals', 'discount_minor')                    AS discount_minor,
    JSONExtractInt(payload, 'totals', 'shipping_minor')                    AS shipping_minor,
    JSONExtractInt(payload, 'totals', 'tax_minor')                         AS tax_minor,
    JSONExtractInt(payload, 'totals', 'total_minor')                       AS total_minor,
    JSONExtractArrayRaw(payload, 'line_items')                             AS line_items,
    parseDateTime64BestEffort(JSONExtractString(payload, 'placed_at'), 3, 'UTC') AS placed_at
FROM (SELECT * FROM raw_events FINAL WHERE topic = 'order.placed' AND version = 2 AND store_id IS NOT NULL);

-- Every order.placed version the facts read. Each version keeps its own view (one per topic version, above);
-- a new version is added here, and nothing downstream changes while the columns stay the same.
CREATE OR REPLACE VIEW stg_order_placed AS
SELECT * FROM stg_order_placed_v1
UNION ALL
SELECT * FROM stg_order_placed_v2;

-- stg_order_line (BI v2, #871): every line of every order.placed version, exploded once, with the order's keys.
-- Line titles stay out (no PII, and names are resolved from Postgres at answer time); the sku is kept.
CREATE OR REPLACE VIEW stg_order_line AS
SELECT
    o.event_id                                                             AS event_id,
    o.organization_id                                                      AS organization_id,
    o.store_id                                                             AS store_id,
    o.order_id                                                             AS order_id,
    o.currency                                                             AS currency,
    o.sales_channel_id                                                     AS sales_channel_id,
    o.shipping_country                                                     AS shipping_country,
    o.placed_at                                                            AS placed_at,
    toUUID(JSONExtractString(li, 'order_line_item_id'))                    AS order_line_item_id,
    toUUIDOrNull(JSONExtractString(li, 'variant_id'))                      AS variant_id,
    JSONExtractString(li, 'sku')                                           AS sku,
    toUInt32(JSONExtractInt(li, 'quantity'))                               AS quantity,
    JSONExtractInt(li, 'unit_price_minor')                                 AS unit_price_minor,
    JSONExtractInt(li, 'discount_minor')                                   AS discount_minor,
    toUInt32(JSONExtractInt(li, 'tax_rate_bp'))                            AS tax_rate_bp,
    JSONExtractInt(li, 'tax_minor')                                        AS tax_minor,
    JSONExtractInt(li, 'total_minor')                                      AS total_minor
FROM stg_order_placed AS o
ARRAY JOIN o.line_items AS li;

CREATE OR REPLACE VIEW stg_order_cancelled_v1 AS
SELECT
    event_id,
    organization_id,
    assumeNotNull(store_id)                                                AS store_id,
    occurred_at,
    toUUID(JSONExtractString(payload, 'order_id'))                         AS order_id,
    parseDateTime64BestEffort(JSONExtractString(payload, 'cancelled_at'), 3, 'UTC') AS cancelled_at
FROM (SELECT * FROM raw_events FINAL WHERE topic = 'order.cancelled' AND version = 1 AND store_id IS NOT NULL);

CREATE OR REPLACE VIEW stg_payment_captured_v1 AS
SELECT
    event_id,
    organization_id,
    assumeNotNull(store_id)                                                AS store_id,
    occurred_at,
    toUUID(JSONExtractString(payload, 'payment_id'))                       AS payment_id,
    toUUID(JSONExtractString(payload, 'order_id'))                         AS order_id,
    toUUID(JSONExtractString(payload, 'legal_entity_id'))                  AS legal_entity_id,
    JSONExtractString(payload, 'provider')                                 AS provider,
    JSONExtractInt(payload, 'amount_minor')                                AS amount_minor,
    JSONExtract(payload, 'fee_minor', 'Nullable(Int64)')                   AS fee_minor,
    JSONExtractString(payload, 'currency')                                 AS currency,
    parseDateTime64BestEffort(JSONExtractString(payload, 'captured_at'), 3, 'UTC') AS captured_at
FROM (SELECT * FROM raw_events FINAL WHERE topic = 'payment.captured' AND version = 1 AND store_id IS NOT NULL);

CREATE OR REPLACE VIEW stg_payment_failed_v1 AS
SELECT
    event_id,
    organization_id,
    assumeNotNull(store_id)                                                AS store_id,
    occurred_at,
    toUUID(JSONExtractString(payload, 'payment_id'))                       AS payment_id,
    toUUID(JSONExtractString(payload, 'order_id'))                         AS order_id,
    JSONExtractString(payload, 'provider')                                 AS provider,
    JSONExtractInt(payload, 'amount_minor')                                AS amount_minor,
    JSONExtractString(payload, 'currency')                                 AS currency,
    parseDateTime64BestEffort(JSONExtractString(payload, 'failed_at'), 3, 'UTC') AS failed_at
FROM (SELECT * FROM raw_events FINAL WHERE topic = 'payment.failed' AND version = 1 AND store_id IS NOT NULL);

CREATE OR REPLACE VIEW stg_refund_issued_v1 AS
SELECT
    event_id,
    organization_id,
    assumeNotNull(store_id)                                                AS store_id,
    occurred_at,
    toUUID(JSONExtractString(payload, 'refund_id'))                        AS refund_id,
    toUUID(JSONExtractString(payload, 'payment_id'))                       AS payment_id,
    toUUID(JSONExtractString(payload, 'order_id'))                         AS order_id,
    toUUID(JSONExtractString(payload, 'legal_entity_id'))                  AS legal_entity_id,
    JSONExtractInt(payload, 'amount_minor')                                AS amount_minor,
    JSONExtractString(payload, 'currency')                                 AS currency,
    JSONExtractString(payload, 'reason')                                   AS reason,
    parseDateTime64BestEffort(JSONExtractString(payload, 'issued_at'), 3, 'UTC') AS issued_at
FROM (SELECT * FROM raw_events FINAL WHERE topic = 'refund.issued' AND version = 1 AND store_id IS NOT NULL);

CREATE OR REPLACE VIEW stg_shipment_shipped_v1 AS
SELECT
    event_id,
    organization_id,
    assumeNotNull(store_id)                                                AS store_id,
    occurred_at,
    toUUID(JSONExtractString(payload, 'shipment_id'))                      AS shipment_id,
    toUUID(JSONExtractString(payload, 'order_id'))                         AS order_id,
    toUUID(JSONExtractString(payload, 'legal_entity_id'))                  AS legal_entity_id,
    toUUID(JSONExtractString(payload, 'warehouse_id'))                     AS warehouse_id,
    JSONExtractString(payload, 'carrier')                                  AS carrier,
    JSONExtract(payload, 'cost_minor', 'Nullable(Int64)')                  AS cost_minor,
    JSONExtractString(payload, 'currency')                                 AS currency,
    JSONExtractArrayRaw(payload, 'items')                                  AS items,
    parseDateTime64BestEffort(JSONExtractString(payload, 'shipped_at'), 3, 'UTC') AS shipped_at
FROM (SELECT * FROM raw_events FINAL WHERE topic = 'shipment.shipped' AND version = 1 AND store_id IS NOT NULL);

CREATE OR REPLACE VIEW stg_product_published_v1 AS
SELECT
    event_id,
    organization_id,
    assumeNotNull(store_id)                                                AS store_id,
    occurred_at,
    toUUID(JSONExtractString(payload, 'product_id'))                       AS product_id,
    JSONExtractArrayRaw(payload, 'variants')                               AS variants,
    -- BI v2 (#871): the category as of this publish (product.updated carries none until #876)
    toUUIDOrNull(JSONExtractString(payload, 'category_id'))                AS category_id
FROM (SELECT * FROM raw_events FINAL WHERE topic = 'product.published' AND version = 1 AND store_id IS NOT NULL);

CREATE OR REPLACE VIEW stg_product_updated_v1 AS
SELECT
    event_id,
    organization_id,
    assumeNotNull(store_id)                                                AS store_id,
    occurred_at,
    toUUID(JSONExtractString(payload, 'product_id'))                       AS product_id,
    JSONExtractString(payload, 'status')                                   AS status,
    JSONExtractArrayRaw(payload, 'variants')                               AS variants
FROM (SELECT * FROM raw_events FINAL WHERE topic = 'product.updated' AND version = 1 AND store_id IS NOT NULL);

CREATE OR REPLACE VIEW stg_store_created_v1 AS
SELECT
    event_id,
    organization_id,
    occurred_at,
    toUUID(JSONExtractString(payload, 'store_id'))                         AS store_id,
    toUUID(JSONExtractString(payload, 'legal_entity_id'))                  AS legal_entity_id,
    JSONExtractString(payload, 'code')                                     AS code,
    JSONExtractString(payload, 'name')                                     AS name,
    JSONExtractString(payload, 'status')                                   AS status,
    JSONExtractString(payload, 'default_currency')                         AS default_currency
FROM (SELECT * FROM raw_events FINAL WHERE topic = 'store.created' AND version = 1);

CREATE OR REPLACE VIEW stg_store_updated_v1 AS
SELECT
    event_id,
    organization_id,
    occurred_at,
    toUUID(JSONExtractString(payload, 'store_id'))                         AS store_id,
    JSONExtractString(payload, 'code')                                     AS code,
    JSONExtractString(payload, 'status')                                   AS status
FROM (SELECT * FROM raw_events FINAL WHERE topic = 'store.updated' AND version = 1);

-- BI v2 (#871) inventory history. stock.moved v2 is the movement ledger; its on_hand_after is exact at each
-- movement, its reserved_after is NOT current (a reservation is not a movement): the current position is read from
-- Postgres (rpt_stock_position), never from here.
CREATE OR REPLACE VIEW stg_stock_moved_v2 AS
SELECT
    event_id,
    organization_id,
    occurred_at,
    toUUID(JSONExtractString(payload, 'stock_movement_id'))                AS stock_movement_id,
    toUUIDOrNull(JSONExtractString(payload, 'stock_item_id'))              AS stock_item_id,
    JSONExtractString(payload, 'sku')                                      AS sku,
    toUUIDOrNull(JSONExtractString(payload, 'variant_id'))                 AS variant_id,
    toUUIDOrNull(JSONExtractString(payload, 'store_id'))                   AS movement_store_id,
    toUUID(JSONExtractString(payload, 'warehouse_id'))                     AS warehouse_id,
    JSONExtractInt(payload, 'delta')                                       AS delta,
    CAST(JSONExtractString(payload, 'reason') AS LowCardinality(String))   AS reason,
    nullIf(JSONExtractString(payload, 'reference_type'), '')               AS reference_type,
    JSONExtractInt(payload, 'on_hand_after')                               AS on_hand_after,
    JSONExtractInt(payload, 'reserved_after')                              AS reserved_after
FROM (SELECT * FROM raw_events FINAL WHERE topic = 'stock.moved' AND version = 2);

-- stock.moved v1: the per-variant ledger before the shared stock pool (#456); no stock item, no store in the payload
-- (the envelope's store is kept). Same columns as v2 so the history reads as one.
CREATE OR REPLACE VIEW stg_stock_moved_v1 AS
SELECT
    event_id,
    organization_id,
    occurred_at,
    toUUID(JSONExtractString(payload, 'stock_movement_id'))                AS stock_movement_id,
    CAST(NULL AS Nullable(UUID))                                           AS stock_item_id,
    JSONExtractString(payload, 'sku')                                      AS sku,
    toUUIDOrNull(JSONExtractString(payload, 'variant_id'))                 AS variant_id,
    store_id                                                               AS movement_store_id,
    toUUID(JSONExtractString(payload, 'warehouse_id'))                     AS warehouse_id,
    JSONExtractInt(payload, 'delta')                                       AS delta,
    CAST(JSONExtractString(payload, 'reason') AS LowCardinality(String))   AS reason,
    nullIf(JSONExtractString(payload, 'reference_type'), '')               AS reference_type,
    JSONExtractInt(payload, 'on_hand_after')                               AS on_hand_after,
    JSONExtractInt(payload, 'reserved_after')                              AS reserved_after
FROM (SELECT * FROM raw_events FINAL WHERE topic = 'stock.moved' AND version = 1);

-- Every stock movement, both versions (v1 rows have no stock item: they predate the pool).
CREATE OR REPLACE VIEW stg_stock_moved AS
SELECT * FROM stg_stock_moved_v2
UNION ALL
SELECT * FROM stg_stock_moved_v1;

-- return.received v1, one row per returned line (items exploded); product and money come from the order line.
CREATE OR REPLACE VIEW stg_return_received_v1 AS
SELECT
    event_id,
    organization_id,
    assumeNotNull(store_id)                                                AS store_id,
    occurred_at,
    toUUID(JSONExtractString(payload, 'return_id'))                        AS return_id,
    toUUID(JSONExtractString(payload, 'order_id'))                         AS order_id,
    toUUIDOrNull(JSONExtractString(payload, 'warehouse_id'))               AS warehouse_id,
    toUUID(JSONExtractString(item, 'order_line_item_id'))                  AS order_line_item_id,
    toUInt32(JSONExtractInt(item, 'quantity'))                             AS quantity,
    nullIf(JSONExtractString(item, 'condition'), '')                       AS condition,
    parseDateTime64BestEffort(JSONExtractString(payload, 'received_at'), 3, 'UTC') AS received_at
FROM (SELECT * FROM raw_events FINAL WHERE topic = 'return.received' AND version = 1 AND store_id IS NOT NULL)
ARRAY JOIN JSONExtractArrayRaw(payload, 'items') AS item;

-- stock_item.mapped v1: which stock item a variant sells from, over time (the sales rate per stock item).
CREATE OR REPLACE VIEW stg_stock_item_mapped_v1 AS
SELECT
    event_id,
    organization_id,
    occurred_at,
    toUUID(JSONExtractString(payload, 'stock_item_id'))                    AS stock_item_id,
    toUUIDOrNull(JSONExtractString(payload, 'previous_stock_item_id'))     AS previous_stock_item_id,
    toUUID(JSONExtractString(payload, 'variant_id'))                       AS variant_id,
    toUUIDOrNull(JSONExtractString(payload, 'store_id'))                   AS mapped_store_id
FROM (SELECT * FROM raw_events FINAL WHERE topic = 'stock_item.mapped' AND version = 1);
