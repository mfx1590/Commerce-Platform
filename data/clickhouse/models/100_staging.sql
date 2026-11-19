-- Staging (#601): one view per topic version the facts read, typed columns out of raw_events.payload.
-- Every view reads raw_events FINAL, so a redelivered event appears once. The filters sit in the subquery, where no
-- output alias exists (`assumeNotNull(store_id) AS store_id` would otherwise turn `store_id IS NOT NULL` into a
-- no-op: the alias-shadow class, sql-lint.ts). Envelope columns first, then the payload's.
-- No PII: customer_id and titles are left out; email_hash is kept only as order.placed's `customer_key` (#623, the
-- erasure-aware pseudonymous key for new vs returning customers).
-- Money is Int64 minor units beside its currency.
-- Every view with a JOIN ends with SETTINGS join_algorithm = 'hash' (BI v2, #871 f): ClickHouse 25.8's default
-- parallel hash join preallocates ~300 MiB per query whatever the data size (fct_order_line on the generated month:
-- 309 MiB → 4.4 MiB), and the shared server's memory cap is ~1.1 GiB. A view's SETTINGS apply when it is read.

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
ARRAY JOIN o.line_items AS li
SETTINGS join_algorithm = 'hash';

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
    parseDateTime64BestEffort(JSONExtractString(payload, 'issued_at'), 3, 'UTC') AS issued_at,
    -- BI v2 wave 2 (#935): the return a refund pays for (NULL for a refund with no return), appended
    toUUIDOrNull(JSONExtract(payload, 'return_id', 'Nullable(String)'))    AS return_id
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
ARRAY JOIN JSONExtractArrayRaw(payload, 'items') AS item
SETTINGS join_algorithm = 'hash';

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

-- ---- BI v2 wave 2 (#935): customers, marketing, operations -------------------------------------------------------
-- stg_customer_v1: customer.created and customer.updated, for the customer's CURRENT group only (dim_customer).
-- customer_id and identity_id (the cross-brand key) are NOT staged: orders and customers join on store_id + the
-- pseudonymous email_hash (= fct_order.customer_key, #623); cross-brand identity is Phase B. The key never leaves the
-- models (the system.columns test names it).
CREATE OR REPLACE VIEW stg_customer_v1 AS
SELECT
    event_id,
    organization_id,
    assumeNotNull(store_id)                                                AS store_id,
    occurred_at,
    nullIf(JSONExtractString(payload, 'email_hash'), '')                   AS customer_key,
    toUUIDOrNull(JSONExtract(payload, 'customer_group_id', 'Nullable(String)')) AS customer_group_id,
    CAST(JSONExtractString(payload, 'status') AS LowCardinality(String))   AS status
FROM (SELECT * FROM raw_events FINAL
      WHERE topic IN ('customer.created', 'customer.updated') AND version = 1 AND store_id IS NOT NULL);

-- stg_attribution_v1: one row per (order, touch). utm values are links customers clicked: lower-cased, trimmed and
-- cut to 64 characters here; the service maps anything PII-shaped, and anything past a store's top 50, to `other`.
-- referrer, landing_path, utm_term and utm_content are not staged.
CREATE OR REPLACE VIEW stg_attribution_v1 AS
SELECT
    event_id,
    organization_id,
    assumeNotNull(store_id)                                                AS store_id,
    occurred_at,
    toUUID(JSONExtractString(payload, 'order_id'))                         AS order_id,
    CAST(JSONExtractString(payload, 'touch') AS LowCardinality(String))    AS touch,
    nullIf(left(lower(trimBoth(JSONExtractString(payload, 'utm_source'))), 64), '')   AS utm_source,
    nullIf(left(lower(trimBoth(JSONExtractString(payload, 'utm_medium'))), 64), '')   AS utm_medium,
    nullIf(left(lower(trimBoth(JSONExtractString(payload, 'utm_campaign'))), 64), '') AS utm_campaign,
    toUUIDOrNull(JSONExtract(payload, 'campaign_id', 'Nullable(String)'))  AS campaign_id
FROM (SELECT * FROM raw_events FINAL WHERE topic = 'attribution.recorded' AND version = 1 AND store_id IS NOT NULL);

-- stg_campaign_v1: campaign.launched and campaign.ended. budget is the PLANNED budget (spend is #873), nullable.
CREATE OR REPLACE VIEW stg_campaign_v1 AS
SELECT
    event_id,
    organization_id,
    assumeNotNull(store_id)                                                AS store_id,
    occurred_at,
    toUUID(JSONExtractString(payload, 'campaign_id'))                      AS campaign_id,
    JSONExtractString(payload, 'name')                                     AS name,
    CAST(JSONExtractString(payload, 'type') AS LowCardinality(String))     AS type,
    JSONExtract(payload, 'budget', 'amount_minor', 'Nullable(Int64)')      AS budget_minor,
    nullIf(JSONExtractString(payload, 'budget', 'currency'), '')           AS budget_currency,
    parseDateTime64BestEffortOrNull(JSONExtractString(payload, 'starts_at'), 3, 'UTC') AS starts_at,
    parseDateTime64BestEffortOrNull(JSONExtractString(payload, 'ends_at'), 3, 'UTC')   AS ends_at
FROM (SELECT * FROM raw_events FINAL
      WHERE topic IN ('campaign.launched', 'campaign.ended') AND version = 1 AND store_id IS NOT NULL);

-- stg_cart_abandoned_v1: no customer column (customer_id and email_hash are not staged).
CREATE OR REPLACE VIEW stg_cart_abandoned_v1 AS
SELECT
    event_id,
    organization_id,
    assumeNotNull(store_id)                                                AS store_id,
    occurred_at,
    toUUID(JSONExtractString(payload, 'cart_id'))                          AS cart_id,
    JSONExtractString(payload, 'currency')                                 AS currency,
    JSONExtractInt(payload, 'total_minor')                                 AS total_minor,
    toUInt32(JSONExtractInt(payload, 'line_item_count'))                   AS line_item_count,
    parseDateTime64BestEffort(JSONExtractString(payload, 'abandoned_at'), 3, 'UTC') AS abandoned_at
FROM (SELECT * FROM raw_events FINAL WHERE topic = 'cart.abandoned' AND version = 1 AND store_id IS NOT NULL);

-- shipment.created carries destination_country (only there); shipment.delivered only shipment_id, order_id, delivered_at.
CREATE OR REPLACE VIEW stg_shipment_created_v1 AS
SELECT
    event_id,
    organization_id,
    assumeNotNull(store_id)                                                AS store_id,
    occurred_at,
    toUUID(JSONExtractString(payload, 'shipment_id'))                      AS shipment_id,
    toUUID(JSONExtractString(payload, 'order_id'))                         AS order_id,
    toUUID(JSONExtractString(payload, 'warehouse_id'))                     AS warehouse_id,
    CAST(lower(JSONExtractString(payload, 'carrier')) AS LowCardinality(String)) AS carrier,
    JSONExtractString(payload, 'destination_country')                      AS destination_country
FROM (SELECT * FROM raw_events FINAL WHERE topic = 'shipment.created' AND version = 1 AND store_id IS NOT NULL);

CREATE OR REPLACE VIEW stg_shipment_delivered_v1 AS
SELECT
    event_id,
    organization_id,
    assumeNotNull(store_id)                                                AS store_id,
    occurred_at,
    toUUID(JSONExtractString(payload, 'shipment_id'))                      AS shipment_id,
    toUUID(JSONExtractString(payload, 'order_id'))                         AS order_id,
    parseDateTime64BestEffort(JSONExtractString(payload, 'delivered_at'), 3, 'UTC') AS delivered_at
FROM (SELECT * FROM raw_events FINAL WHERE topic = 'shipment.delivered' AND version = 1 AND store_id IS NOT NULL);

CREATE OR REPLACE VIEW stg_payment_authorized_v1 AS
SELECT
    event_id,
    organization_id,
    assumeNotNull(store_id)                                                AS store_id,
    occurred_at,
    toUUID(JSONExtractString(payload, 'payment_id'))                       AS payment_id,
    toUUID(JSONExtractString(payload, 'order_id'))                         AS order_id,
    JSONExtractString(payload, 'provider')                                 AS provider,
    parseDateTime64BestEffort(JSONExtractString(payload, 'authorized_at'), 3, 'UTC') AS authorized_at
FROM (SELECT * FROM raw_events FINAL WHERE topic = 'payment.authorized' AND version = 1 AND store_id IS NOT NULL);

-- stg_payment_failure_v1: payment.failed with a normalised failure_code. failure_reason is unconstrained text: only a
-- code-shaped value (lower-cased, ^[a-z0-9_]{1,40}$) is kept, anything else (free text, NULL) is `other`. The raw
-- reason is not staged. (stg_payment_failed_v1 stays as it is: it is #601's.)
CREATE OR REPLACE VIEW stg_payment_failure_v1 AS
SELECT
    event_id,
    organization_id,
    assumeNotNull(store_id)                                                AS store_id,
    occurred_at,
    toUUID(JSONExtractString(payload, 'payment_id'))                       AS payment_id,
    toUUID(JSONExtractString(payload, 'order_id'))                         AS order_id,
    JSONExtractString(payload, 'provider')                                 AS provider,
    CAST(if(match(lower(JSONExtractString(payload, 'failure_reason')), '^[a-z0-9_]{1,40}$'),
            lower(JSONExtractString(payload, 'failure_reason')), 'other') AS LowCardinality(String)) AS failure_code,
    parseDateTime64BestEffort(JSONExtractString(payload, 'failed_at'), 3, 'UTC') AS failed_at
FROM (SELECT * FROM raw_events FINAL WHERE topic = 'payment.failed' AND version = 1 AND store_id IS NOT NULL);

CREATE OR REPLACE VIEW stg_refund_failed_v1 AS
SELECT
    event_id,
    organization_id,
    assumeNotNull(store_id)                                                AS store_id,
    occurred_at,
    toUUID(JSONExtractString(payload, 'refund_id'))                        AS refund_id,
    toUUID(JSONExtractString(payload, 'order_id'))                         AS order_id,
    JSONExtractString(payload, 'currency')                                 AS currency,
    parseDateTime64BestEffort(JSONExtractString(payload, 'failed_at'), 3, 'UTC') AS failed_at
FROM (SELECT * FROM raw_events FINAL WHERE topic = 'refund.failed' AND version = 1 AND store_id IS NOT NULL);

-- stg_return_requested_v1: the free-text reason is NOT staged (#937 brings a reason_code).
CREATE OR REPLACE VIEW stg_return_requested_v1 AS
SELECT
    event_id,
    organization_id,
    assumeNotNull(store_id)                                                AS store_id,
    occurred_at,
    toUUID(JSONExtractString(payload, 'return_id'))                        AS return_id,
    toUUID(JSONExtractString(payload, 'order_id'))                         AS order_id,
    parseDateTime64BestEffort(JSONExtractString(payload, 'requested_at'), 3, 'UTC') AS requested_at
FROM (SELECT * FROM raw_events FINAL WHERE topic = 'return.requested' AND version = 1 AND store_id IS NOT NULL);
