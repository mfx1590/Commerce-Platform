-- PROPOSED (CONTRACT CHANGE, window 11, task 3.1 / #435): packages/db/migrations/0191_stock_pool_rekey.sql.
--
-- Kept here verbatim until the main window applies it; the hq-warehouse tests apply 0190 + 0191 to a seeded
-- throwaway database (the #244 pattern).
--
-- 0191 stock pool, step 2 of 2 (REKEY — lands ONLY together with the inventory module's rewrite, window 1):
-- stock is held per (stock item, warehouse), not per (store's variant, warehouse).
--   * product_variant.stock_item_id becomes NOT NULL; a new variant gets its own item automatically (trigger).
--   * inventory_level: keyed and UNIQUE on (stock_item_id, warehouse_id); store_id and variant_id are dropped.
--   * reservation: gains stock_item_id and allocation_rule; KEEPS store_id (who reserved) and variant_id.
--   * stock_movement: gains stock_item_id; store_id and variant_id become nullable (both NULL = a pool movement
--     no store caused: a receipt, a transfer, a cycle count).
-- RLS: inventory_level and stock_movement move from the `store` kind to the `pool` kind (0190); reservation stays
-- `store`. So a store sees the pool row of an item it maps — including the `reserved` total — and never another
-- store's reservation rows.

-- 1. Variants created since 0190 (same idempotent statement), then the column is mandatory.
ALTER TABLE product_variant DISABLE TRIGGER set_updated_at;
SELECT app.backfill_stock_items();
ALTER TABLE product_variant ENABLE TRIGGER set_updated_at;
ALTER TABLE product_variant ALTER COLUMN stock_item_id SET NOT NULL;

-- 2. A variant inserted without a stock item gets its own (1:1, the backfill's naming rule). The catalog creates
--    variants in STORE scope, and a store session may not insert into stock_item (policy `pool_self`), so the
--    function is SECURITY DEFINER and raises the scope to `organization` for exactly its own two statements —
--    it must see every item of the organization to apply the sku rule, whatever role owns the migration.
CREATE OR REPLACE FUNCTION app.variant_stock_item() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  prev_scope text := coalesce(current_setting('app.scope', true), '');
  item_sku   text := NEW.sku;
BEGIN
  IF NEW.stock_item_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  PERFORM set_config('app.scope', 'organization', true);
  IF EXISTS (SELECT 1 FROM stock_item si WHERE si.organization_id = NEW.organization_id AND si.sku = NEW.sku) THEN
    SELECT s.code || ':' || NEW.sku INTO item_sku FROM store s WHERE s.id = NEW.store_id;
  END IF;
  INSERT INTO stock_item (organization_id, sku, name, barcode)
  SELECT NEW.organization_id, item_sku,
         p.title || CASE WHEN NEW.title <> '' AND NEW.title <> p.title THEN ' — ' || NEW.title ELSE '' END,
         NEW.barcode
  FROM product p WHERE p.id = NEW.product_id
  RETURNING id INTO NEW.stock_item_id;
  PERFORM set_config('app.scope', prev_scope, true);
  RETURN NEW;
END $$;
CREATE TRIGGER variant_stock_item BEFORE INSERT ON product_variant
  FOR EACH ROW EXECUTE FUNCTION app.variant_stock_item();

-- 3. Re-mapping a variant is an HQ act (`mapVariantToStockItem`, `operations` on organization:hq). The API checks
--    the permission; this is the database's own refusal for a store-scoped session, whose policy on product_variant
--    would otherwise let it point its variant at any item it can see.
CREATE OR REPLACE FUNCTION app.guard_variant_remap() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.stock_item_id IS DISTINCT FROM OLD.stock_item_id AND app.current_scope() = 'store' THEN
    RAISE EXCEPTION 'a store-scoped session cannot re-map a variant to another stock item'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_variant_remap BEFORE UPDATE OF stock_item_id ON product_variant
  FOR EACH ROW EXECUTE FUNCTION app.guard_variant_remap();

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
SELECT app.apply_rls('stock_movement', 'pool');
-- Still append-only for the application role (0009's REVOKE UPDATE, DELETE is untouched).
