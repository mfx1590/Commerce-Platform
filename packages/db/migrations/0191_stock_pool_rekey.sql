-- Landed from CONTRACT CHANGE #453 (window 11, task 3.1 / #435), manager decision 2026-10-12, together with the
-- inventory module's rewrite (window 1, #456). The SQL below is the proposed file verbatim.
--
-- 0191 stock pool, step 2 of 2 (REKEY — lands ONLY together with the inventory module's rewrite, window 1):
-- stock is held per (stock item, warehouse), not per (store's variant, warehouse).
--   * product_variant.stock_item_id becomes NOT NULL; a new variant gets its own item automatically (trigger).
--   * inventory_level: keyed and UNIQUE on (stock_item_id, warehouse_id); store_id and variant_id are dropped.
--   * reservation: gains stock_item_id and allocation_rule; KEEPS store_id (who reserved) and variant_id.
--   * stock_movement: gains stock_item_id; store_id and variant_id become nullable (both NULL = a pool movement
--     no store caused: a receipt, a transfer, a cycle count).
-- RLS (kinds from 0190): inventory_level moves from `store` to `pool`, stock_movement to `pool_ledger`;
-- reservation stays `store`. So a store sees the pool row of an item it maps — including the `reserved` total —
-- and never another store's reservation rows or movements, nor a movement no store caused.

-- 1. Variants created since 0190 (same idempotent statement), then the column is mandatory.
ALTER TABLE product_variant DISABLE TRIGGER set_updated_at;
SELECT app.backfill_stock_items();
ALTER TABLE product_variant ENABLE TRIGGER set_updated_at;
ALTER TABLE product_variant ALTER COLUMN stock_item_id SET NOT NULL;

-- 2. A variant inserted without a stock item gets its own (1:1, the backfill's naming rule). The catalog creates
--    variants in STORE scope, and a store session may not insert into stock_item (policy `pool_self`), so the
--    function is SECURITY DEFINER and runs in organization scope — which it also needs to apply the sku rule
--    against items the store cannot see. The scope is the function's own SET clause: Postgres restores it on
--    return AND on error, so no exit path can leave the session elevated. A variant that arrives already mapped
--    is left alone here; whether the session may do that is 0190's guard_variant_stock_item, which fires first
--    (trigger names sort) and sees the value the session sent.
CREATE OR REPLACE FUNCTION app.variant_stock_item() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
SET app.scope = 'organization' AS $$
DECLARE
  item_sku text := NEW.sku;
BEGIN
  IF NEW.stock_item_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM stock_item si WHERE si.organization_id = NEW.organization_id AND si.sku = NEW.sku) THEN
    SELECT s.code || ':' || NEW.sku INTO item_sku FROM store s WHERE s.id = NEW.store_id;
  END IF;
  INSERT INTO stock_item (organization_id, sku, name, barcode)
  SELECT NEW.organization_id, item_sku,
         p.title || CASE WHEN NEW.title <> '' AND NEW.title <> p.title THEN ' — ' || NEW.title ELSE '' END,
         NEW.barcode
  FROM product p WHERE p.id = NEW.product_id
  RETURNING id INTO NEW.stock_item_id;
  RETURN NEW;
END $$;
-- It can only run as a trigger; nobody needs to call it.
REVOKE EXECUTE ON FUNCTION app.variant_stock_item() FROM PUBLIC, platform_app;
CREATE TRIGGER variant_stock_item BEFORE INSERT ON product_variant
  FOR EACH ROW EXECUTE FUNCTION app.variant_stock_item();

-- 3. (Re-mapping a variant is refused outside organization scope by 0190's guard_variant_stock_item.)

-- 4. inventory_level → pool rows.
DROP POLICY tenant_isolation ON inventory_level;
ALTER TABLE inventory_level ADD COLUMN stock_item_id uuid REFERENCES stock_item(id);
UPDATE inventory_level il SET stock_item_id = v.stock_item_id FROM product_variant v WHERE v.id = il.variant_id;
DO $$
BEGIN
  -- Mapping is 1:1 until this migration (no mapping API before it), so this cannot fire; if it does, somebody
  -- pooled by hand and summing two levels silently is not this migration's call.
  IF EXISTS (SELECT 1 FROM inventory_level GROUP BY stock_item_id, warehouse_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION '0191: two inventory levels share a stock item and a warehouse; resolve by hand first';
  END IF;
END $$;
ALTER TABLE inventory_level ALTER COLUMN stock_item_id SET NOT NULL;
ALTER TABLE inventory_level DROP COLUMN variant_id;   -- takes UNIQUE (variant_id, warehouse_id) with it
ALTER TABLE inventory_level DROP COLUMN store_id;
ALTER TABLE inventory_level ADD CONSTRAINT inventory_level_stock_item_warehouse_key UNIQUE (stock_item_id, warehouse_id);
SELECT app.apply_rls('inventory_level', 'pool');

-- 5. reservation: which pool row it holds, and why the allocation chose that warehouse (shown in the admin).
ALTER TABLE reservation ADD COLUMN stock_item_id uuid REFERENCES stock_item(id);
ALTER TABLE reservation ADD COLUMN allocation_rule text;
UPDATE reservation r SET stock_item_id = v.stock_item_id FROM product_variant v WHERE v.id = r.variant_id;
ALTER TABLE reservation ALTER COLUMN stock_item_id SET NOT NULL;
CREATE INDEX reservation_stock_item_idx ON reservation (stock_item_id, warehouse_id) WHERE released_at IS NULL;

-- 6. stock_movement: the ledger of the pool. History keeps the store and variant it was written with.
DROP POLICY tenant_isolation ON stock_movement;
ALTER TABLE stock_movement ADD COLUMN stock_item_id uuid REFERENCES stock_item(id);
UPDATE stock_movement m SET stock_item_id = v.stock_item_id FROM product_variant v WHERE v.id = m.variant_id;
ALTER TABLE stock_movement ALTER COLUMN stock_item_id SET NOT NULL;
ALTER TABLE stock_movement ALTER COLUMN store_id DROP NOT NULL;
ALTER TABLE stock_movement ALTER COLUMN variant_id DROP NOT NULL;
ALTER TABLE stock_movement ADD CONSTRAINT stock_movement_store_attribution_check
  CHECK ((store_id IS NULL) = (variant_id IS NULL));
CREATE INDEX stock_movement_stock_item_idx ON stock_movement (stock_item_id, warehouse_id, created_at DESC);
SELECT app.apply_rls('stock_movement', 'pool_ledger');
-- Still append-only for the application role (0009's REVOKE UPDATE, DELETE is untouched).
