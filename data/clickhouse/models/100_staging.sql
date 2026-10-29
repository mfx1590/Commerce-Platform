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
    JSONExtractArrayRaw(payload, 'variants')                               AS variants
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
