-- Dimensions (#601).
--
-- dim_variant (binding for window 9, #607): variant_id → product_id per store, from the `variants[]` of
-- product.published and product.updated; the latest event wins. order.placed line items carry only variant_id,
-- so fct_order_line resolves product_id through this view.
CREATE OR REPLACE VIEW dim_variant AS
SELECT
    store_id,
    variant_id,
    argMax(product_id, occurred_at)  AS product_id,
    argMax(sku, occurred_at)         AS sku,
    max(occurred_at)                 AS last_seen_at
FROM
(
    SELECT
        store_id,
        occurred_at,
        product_id,
        toUUID(JSONExtractString(v, 'variant_id')) AS variant_id,
        JSONExtractString(v, 'sku')                AS sku
    FROM
    (
        SELECT store_id, occurred_at, product_id, variants FROM stg_product_published_v1
        UNION ALL
        SELECT store_id, occurred_at, product_id, variants FROM stg_product_updated_v1
    )
    ARRAY JOIN variants AS v
)
GROUP BY store_id, variant_id;

-- dim_store: from store.created (legal entity, name, default currency) and store.updated (code, status; latest wins).
CREATE OR REPLACE VIEW dim_store AS
SELECT
    store_id,
    any(organization_id)                                    AS organization_id,
    argMaxIf(legal_entity_id, occurred_at, is_created = 1)  AS legal_entity_id,
    argMax(code, occurred_at)                               AS code,
    argMaxIf(name, occurred_at, is_created = 1)             AS name,
    argMax(status, occurred_at)                             AS status,
    argMaxIf(default_currency, occurred_at, is_created = 1) AS default_currency,
    max(occurred_at)                                        AS last_seen_at
FROM
(
    SELECT store_id, organization_id, occurred_at, toUInt8(1) AS is_created,
           legal_entity_id, code, name, status, default_currency
    FROM stg_store_created_v1
    UNION ALL
    SELECT store_id, organization_id, occurred_at, toUInt8(0) AS is_created,
           toUUID('00000000-0000-0000-0000-000000000000') AS legal_entity_id, code, '' AS name, status,
           '' AS default_currency
    FROM stg_store_updated_v1
)
GROUP BY store_id;
