-- Landed from CONTRACT CHANGE #458 (window 11, task 3.2 / #436), manager decision 2026-10-12. The SQL below is the
-- proposed file verbatim.
--
-- 0192 cycle counts: `cycle_count` — somebody counted a stock item on a shelf — and what became of the count.
-- A count never edits a level. Reconciliation turns the difference into exactly ONE `stock_movement` (reason
-- `cycle_count`, through the inventory module, with its `stock.moved` outbox row) and links it here; that link is
-- what makes a second reconcile of the same count a no-op.
--
-- Needs only `stock_item` (0190). It does not touch the tables 0191 re-keys.
--
--   status     recorded   written down, not reconciled yet
--              flagged    reconciled, the discrepancy is above organization.settings.warehouse.count_tolerance:
--                         nothing moved; waits for an approval by `operations` on organization:hq
--              applied    reconciled; `stock_movement_id` is the movement (NULL only when the delta was 0)
--
--   on_hand_as_of_count, delta   what the reconciliation computed under the pool row's lock, the last time it
--                                ran: on-hand as of `counted_at` (on-hand now minus the movements since), and
--                                counted_quantity minus that. Final once the count is applied.

CREATE TABLE cycle_count (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organization(id),
  warehouse_id        uuid NOT NULL REFERENCES warehouse(id),
  stock_item_id       uuid NOT NULL REFERENCES stock_item(id),
  counted_quantity    integer NOT NULL CHECK (counted_quantity >= 0),
  counted_by          uuid REFERENCES staff_user(id),        -- NULL = a system source (a WMS pull)
  counted_at          timestamptz NOT NULL,
  source              text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'wms')),
  note                text,
  status              text NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded', 'flagged', 'applied')),
  on_hand_as_of_count integer,
  delta               integer,
  stock_movement_id   uuid UNIQUE REFERENCES stock_movement(id),
  approved_by         uuid REFERENCES staff_user(id),
  approved_at         timestamptz,
  reconciled_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- a reconciled count carries what was computed
  CHECK (status = 'recorded' OR (on_hand_as_of_count IS NOT NULL AND delta IS NOT NULL AND reconciled_at IS NOT NULL)),
  CHECK (delta IS NULL OR delta = counted_quantity - on_hand_as_of_count),
  -- a movement exists exactly when a non-zero delta was applied
  CHECK ((stock_movement_id IS NOT NULL) = (status = 'applied' AND delta <> 0)),
  -- a manual count has a counter; a WMS pull has none
  CHECK ((source = 'manual') = (counted_by IS NOT NULL)),
  CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  CHECK (approved_at IS NULL OR status = 'applied')
);
CREATE INDEX cycle_count_shelf_idx ON cycle_count (stock_item_id, warehouse_id, counted_at DESC);
CREATE INDEX cycle_count_open_idx ON cycle_count (organization_id, warehouse_id, counted_at) WHERE status <> 'applied';

-- One more row-level-security kind (0190's function re-created; its seven existing kinds are unchanged):
-- `organization_only` — the organization's rows, in organization scope ONLY. Counts are an HQ record: no store
-- session reads or writes one, not even for an item it maps.
CREATE OR REPLACE FUNCTION app.apply_rls(p_table text, p_kind text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  pred text;
BEGIN
  IF p_kind = 'organization' THEN
    pred := 'organization_id = app.current_organization_id()';
  ELSIF p_kind = 'organization_only' THEN
    pred := 'organization_id = app.current_organization_id() AND app.current_scope() = ''organization''';
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
  ELSIF p_kind = 'pool_ledger' THEN
    pred := format('organization_id = app.current_organization_id() AND (app.current_scope() = ''organization'' OR (EXISTS (SELECT 1 FROM product_variant v WHERE v.stock_item_id = %I.stock_item_id) AND app.can_access_store(store_id)))', p_table);
  ELSE
    RAISE EXCEPTION 'unknown rls kind %', p_kind;
  END IF;

  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', p_table);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', p_table);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (%s) WITH CHECK (%s)', p_table, pred, pred);
END $$;

SELECT app.apply_rls('cycle_count', 'organization_only');
CREATE TRIGGER set_updated_at BEFORE UPDATE ON cycle_count
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- A count is a record and is never deleted (as audit_log and stock_movement are protected). UPDATE stays: the
-- row is updated as it is reconciled.
REVOKE DELETE ON cycle_count FROM platform_app;
