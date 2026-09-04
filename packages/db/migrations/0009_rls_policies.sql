-- 0009 row-level security on every table + grants for platform_app + updated_at triggers.
-- Policy model (ADR 0001):
--   organization-level tables: visible when organization_id = app.current_organization_id()
--   store-level tables:        additionally app.can_access_store(store_id)
--   audit_log (store_id NULL = org-level action): NULL rows only in organization scope
-- FORCE RLS means even the table owner is subject to the policies: seeds and tests must set context too.

CREATE OR REPLACE FUNCTION app.apply_rls(p_table text, p_kind text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  q text;
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
  ELSE
    RAISE EXCEPTION 'unknown rls kind %', p_kind;
  END IF;

  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', p_table);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', p_table);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (%s) WITH CHECK (%s)', p_table, pred, pred);
END $$;

-- organization-level (organization.id is the tenant itself)
ALTER TABLE organization ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organization USING (id = app.current_organization_id()) WITH CHECK (id = app.current_organization_id());

SELECT app.apply_rls(t, 'organization') FROM unnest(ARRAY[
  'legal_entity','warehouse','staff_user','role_assignment','customer_identity'
]) AS t;

SELECT app.apply_rls('audit_log', 'store_nullable');
SELECT app.apply_rls('store', 'store_self');

-- store-level
SELECT app.apply_rls(t, 'store') FROM unnest(ARRAY[
  'store_domain','store_locale','store_currency','sales_channel','store_api_key',
  'product_category','product','product_option','product_variant','product_media',
  'customer_group','price_list','price','promotion','tax_rate','shipping_option',
  'customer','customer_address',
  'cart','cart_line_item','order','order_line_item','payment','return','refund','return_item','shipment','shipment_item',
  'inventory_level','stock_movement','reservation','ledger_entry'
]) AS t;

-- updated_at maintenance on every table that has the column
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.table_name FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.column_name = 'updated_at'
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS set_updated_at ON %I', r.table_name);
    EXECUTE format('CREATE TRIGGER set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION app.set_updated_at()', r.table_name);
  END LOOP;
END $$;

-- grants for the application role (RLS applies). Append-only tables get no UPDATE/DELETE.
GRANT USAGE ON SCHEMA public TO platform_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO platform_app;
REVOKE UPDATE, DELETE ON audit_log, stock_movement FROM platform_app;
REVOKE ALL ON schema_migrations FROM platform_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO platform_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO platform_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO platform_app;
