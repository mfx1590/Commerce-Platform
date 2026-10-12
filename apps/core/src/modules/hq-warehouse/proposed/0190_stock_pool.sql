-- PROPOSED (CONTRACT CHANGE, window 11, task 3.1 / #435): packages/db/migrations/0190_stock_pool.sql.
--
-- Kept here verbatim until the main window applies it. The hq-warehouse tests apply this file (and 0191) to their
-- own throwaway database, so the code is exercised against exactly the schema being proposed (the #244 pattern).
--
-- 0190 stock pool, step 1 of 2 (EXPAND — landable alone, breaks nothing): `stock_item`, the organization-level
-- thing that physically lies on a shelf, and `product_variant.stock_item_id` (nullable), backfilled 1:1.
-- Nothing reads the new column yet; `inventory_level`, `reservation` and `stock_movement` are untouched and stay
-- keyed by variant until 0191, which lands together with the inventory module's rewrite.
--
-- Backfill rule (manager, 2026-10-12): one stock item per variant, NEVER an automatic merge. The item's sku is the
-- variant's when no other variant and no stock item of the organization carries it, else `<store code>:<sku>`.
-- Pooling two brands onto one item is only ever an explicit `mapVariantToStockItem` (Admin API, with 0191).

CREATE TABLE stock_item (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  sku             text NOT NULL CHECK (sku <> ''),
  name            text NOT NULL,
  barcode         text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, sku)
);

ALTER TABLE product_variant ADD COLUMN stock_item_id uuid REFERENCES stock_item(id);
CREATE INDEX product_variant_stock_item_idx ON product_variant (stock_item_id);

-- Two row-level-security kinds for the pool (0009's function, re-created with them; the four existing kinds are
-- unchanged). A pool row is visible and writable
--   * in organization scope (HQ): always;
--   * in store scope: ONLY when a variant of one of the session's stores maps the row's stock item. The subquery
--     reads product_variant under ITS policy (the `store` kind: organization + app.can_access_store(store_id)),
--     which names no pool table — so there is no policy recursion — and already limits it to accessible stores.
-- `pool_self` is for stock_item (the item is the row's id), `pool` for tables carrying stock_item_id (0191).
-- Consequence, wanted: a store session cannot INSERT a stock_item (no variant maps a row that does not exist yet).
CREATE OR REPLACE FUNCTION app.apply_rls(p_table text, p_kind text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  pred text;
BEGIN
  IF p_kind = 'organization' THEN
    pred := 'organization_id = app.current_organization_id()';
  ELSIF p_kind = 'store' THEN
    pred := 'organization_id = app.current_organization_id() AND app.can_access_store(store_id)';
  ELSIF p_kind = 'store_self' THEN
    pred := 'organization_id = app.current_organization_id() AND app.can_access_store(id)';
  ELSIF p_kind = 'store_nullable' THEN
    pred := 'organization_id = app.current_organization_id() AND ((store_id IS NULL AND app.current_scope() = ''organization'') OR app.can_access_store(store_id))';
  ELSIF p_kind = 'pool_self' THEN
    pred := format('organization_id = app.current_organization_id() AND (app.current_scope() = ''organization'' OR EXISTS (SELECT 1 FROM product_variant v WHERE v.stock_item_id = %I.id))', p_table);
  ELSIF p_kind = 'pool' THEN
    pred := format('organization_id = app.current_organization_id() AND (app.current_scope() = ''organization'' OR EXISTS (SELECT 1 FROM product_variant v WHERE v.stock_item_id = %I.stock_item_id))', p_table);
  ELSE
    RAISE EXCEPTION 'unknown rls kind %', p_kind;
  END IF;

  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', p_table);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', p_table);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (%s) WITH CHECK (%s)', p_table, pred, pred);
END $$;

SELECT app.apply_rls('stock_item', 'pool_self');
CREATE TRIGGER set_updated_at BEFORE UPDATE ON stock_item
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- The backfill, as a function because 0191 runs the very same statement again for variants created in between.
-- Idempotent: it only touches variants whose stock_item_id is still NULL. Runs as the migration role.
CREATE OR REPLACE FUNCTION app.backfill_stock_items() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  n integer;
BEGIN
  WITH todo AS MATERIALIZED (
    SELECT v.id AS variant_id, v.organization_id, v.barcode,
           p.title || CASE WHEN v.title <> '' AND v.title <> p.title THEN ' — ' || v.title ELSE '' END AS name,
           CASE
             WHEN count(*) OVER (PARTITION BY v.organization_id, v.sku) = 1
              AND NOT EXISTS (SELECT 1 FROM stock_item si
                              WHERE si.organization_id = v.organization_id AND si.sku = v.sku)
             THEN v.sku
             ELSE s.code || ':' || v.sku
           END AS item_sku,
           gen_random_uuid() AS item_id
    FROM product_variant v
    JOIN product p ON p.id = v.product_id
    JOIN store s ON s.id = v.store_id
    WHERE v.stock_item_id IS NULL
  ), made AS (
    INSERT INTO stock_item (id, organization_id, sku, name, barcode)
    SELECT item_id, organization_id, item_sku, name, barcode FROM todo
    RETURNING id
  )
  UPDATE product_variant v SET stock_item_id = t.item_id
  FROM todo t WHERE v.id = t.variant_id AND EXISTS (SELECT 1 FROM made m WHERE m.id = t.item_id);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE EXECUTE ON FUNCTION app.backfill_stock_items() FROM PUBLIC, platform_app;

-- product_variant's set_updated_at trigger would stamp every variant with the migration's time; a backfill is not
-- an edit of the variant.
ALTER TABLE product_variant DISABLE TRIGGER set_updated_at;
SELECT app.backfill_stock_items();
ALTER TABLE product_variant ENABLE TRIGGER set_updated_at;
