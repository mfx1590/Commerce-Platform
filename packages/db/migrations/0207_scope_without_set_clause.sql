-- 0207 (#497, db 0.3.22): the scope-elevating functions without a function-level `SET app.scope` clause.
--
-- Postgres 15+ lets only a superuser (or a role granted SET on the parameter, which only a superuser can grant)
-- create a function whose SET clause names a placeholder parameter such as app.scope. On managed Postgres (RDS,
-- Neon) the migration role is not superuser, so 0190, 0191, 0196 and 0197 could not even be created there. Those
-- files were changed in place to set the scope in the body (set_config(..., true), restored before every return; an
-- error aborts the (sub)transaction, which reverts it): the runner identifies a migration by file name only (no
-- checksum), so a database that already applied them never reads them again. Every such database applied them as
-- the local superuser, with the SET clause; this file re-creates the four functions exactly as the edited files now
-- define them, so every database — already migrated or fresh — ends with the same definitions. Behaviour is
-- unchanged. CREATE OR REPLACE keeps each function's owner and grants (REVOKEs from 0190, 0191, 0196, 0197).
-- Idempotent; no data change.

CREATE OR REPLACE FUNCTION app.backfill_stock_items() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  n integer;
  v_scope text := current_setting('app.scope', true);
BEGIN
  PERFORM set_config('app.scope', 'organization', true);
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
  PERFORM set_config('app.scope', coalesce(v_scope, ''), true);
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION app.variant_stock_item() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  item_sku text := NEW.sku;
  v_scope text := current_setting('app.scope', true);
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
  FROM product p
  WHERE p.id = NEW.product_id AND p.store_id = NEW.store_id AND p.organization_id = NEW.organization_id
  RETURNING id INTO NEW.stock_item_id;
  IF NEW.stock_item_id IS NULL THEN
    RAISE EXCEPTION 'a new variant''s product must belong to the variant''s own store'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM set_config('app.scope', coalesce(v_scope, ''), true);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.link_customer_identity(
  p_customer_id uuid, p_subject text, p_email_hash text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_org uuid := current_setting('app.organization_id')::uuid;
  v_store_ids text := coalesce(current_setting('app.store_ids', true), '');
  v_customer uuid;
  v_customer_org uuid;
  v_customer_store uuid;
  v_identity uuid;
  v_guest uuid;
  v_guests integer;
  v_rows_all integer;
  v_rows_locked integer;
  v_merged integer;
  v_scope text := current_setting('app.scope', true);
BEGIN
  PERFORM set_config('app.scope', 'organization', true);
  IF p_subject IS NULL OR p_subject = '' THEN
    RAISE EXCEPTION 'link_customer_identity: a subject is required';
  END IF;
  SELECT c.id, c.organization_id, c.store_id INTO v_customer, v_customer_org, v_customer_store
    FROM customer c WHERE c.id = p_customer_id;
  IF v_customer IS NULL OR v_customer_org <> v_org
     OR (v_store_ids <> '' AND NOT (v_customer_store = ANY (string_to_array(v_store_ids, ',')::uuid[]))) THEN
    RAISE EXCEPTION 'link_customer_identity: the customer is not in this session''s scope'
      USING ERRCODE = '42501';
  END IF;
  SELECT id INTO v_identity FROM customer_identity
   WHERE organization_id = v_org AND keycloak_subject = p_subject AND merged_into_id IS NULL;
  IF v_identity IS NULL THEN
    INSERT INTO customer_identity (organization_id, email_hash, keycloak_subject)
    VALUES (v_org, p_email_hash, p_subject)
    ON CONFLICT (organization_id, keycloak_subject) WHERE keycloak_subject IS NOT NULL DO NOTHING
    RETURNING id INTO v_identity;
    IF v_identity IS NULL THEN -- lost a race: the other transaction created it
      SELECT id INTO v_identity FROM customer_identity
       WHERE organization_id = v_org AND keycloak_subject = p_subject AND merged_into_id IS NULL;
    END IF;
  END IF;
  -- the guest merge: exactly one subjectless, unmerged identity with this email_hash; two or more → no merge
  SELECT count(*) INTO v_guests FROM customer_identity
   WHERE organization_id = v_org AND email_hash = p_email_hash
     AND keycloak_subject IS NULL AND merged_into_id IS NULL AND id <> v_identity;
  IF v_guests = 1 THEN
    SELECT id INTO v_guest FROM customer_identity
     WHERE organization_id = v_org AND email_hash = p_email_hash
       AND keycloak_subject IS NULL AND merged_into_id IS NULL AND id <> v_identity;
    -- lock order: the guest's customer rows first (rows this transaction already holds are returned), the identity
    -- second; a row held by another transaction means that transaction is adopting the guest → leave the merge to it
    SELECT count(*) INTO v_rows_all FROM customer
     WHERE identity_id = v_guest AND organization_id = v_org;
    SELECT count(*) INTO v_rows_locked FROM (
      SELECT 1 FROM customer
       WHERE identity_id = v_guest AND organization_id = v_org
       FOR UPDATE SKIP LOCKED
    ) locked;
    IF v_rows_locked = v_rows_all THEN
      PERFORM 1 FROM customer_identity WHERE id = v_guest FOR UPDATE;
      UPDATE customer_identity SET merged_into_id = v_identity, updated_at = now()
       WHERE id = v_guest AND merged_into_id IS NULL;
      GET DIAGNOSTICS v_merged = ROW_COUNT;
      IF v_merged = 1 THEN
        UPDATE customer SET identity_id = v_identity
         WHERE identity_id = v_guest AND organization_id = v_org;
      END IF;
    END IF;
  END IF;
  UPDATE customer SET identity_id = v_identity
   WHERE id = p_customer_id AND organization_id = v_org AND identity_id IS DISTINCT FROM v_identity;
  PERFORM set_config('app.scope', coalesce(v_scope, ''), true);
  RETURN v_identity;
END $$;

CREATE OR REPLACE FUNCTION app.unlink_customer_identity(p_customer_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  v_org uuid := current_setting('app.organization_id')::uuid;
  v_store_ids text := coalesce(current_setting('app.store_ids', true), '');
  v_customer uuid;
  v_customer_org uuid;
  v_customer_store uuid;
  v_identity uuid;
  v_deleted boolean;
  v_scope text := current_setting('app.scope', true);
BEGIN
  PERFORM set_config('app.scope', 'organization', true);
  SELECT c.id, c.organization_id, c.store_id, c.identity_id
    INTO v_customer, v_customer_org, v_customer_store, v_identity
    FROM customer c WHERE c.id = p_customer_id FOR NO KEY UPDATE;
  IF v_customer IS NULL OR v_customer_org <> v_org
     OR (v_store_ids <> '' AND NOT (v_customer_store = ANY (string_to_array(v_store_ids, ',')::uuid[]))) THEN
    RAISE EXCEPTION 'unlink_customer_identity: the customer is not in this session''s scope'
      USING ERRCODE = '42501';
  END IF;
  IF v_identity IS NULL THEN
    PERFORM set_config('app.scope', coalesce(v_scope, ''), true);
    RETURN false;
  END IF;
  UPDATE customer SET identity_id = NULL WHERE id = p_customer_id;
  DELETE FROM customer_identity ci
   WHERE ci.id = v_identity
     AND NOT EXISTS (SELECT 1 FROM customer c WHERE c.identity_id = v_identity)
     AND NOT EXISTS (SELECT 1 FROM customer_identity m WHERE m.merged_into_id = v_identity);
  v_deleted := FOUND; -- before PERFORM, which resets FOUND
  PERFORM set_config('app.scope', coalesce(v_scope, ''), true);
  RETURN v_deleted;
END $$;
