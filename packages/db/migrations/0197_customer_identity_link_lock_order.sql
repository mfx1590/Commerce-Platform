-- 0197 customer_identity: the guest merge in app.link_customer_identity takes its locks in one order (manager fix,
-- 2026-10-19, after main's unit job hit 40P01 on the #504 condition-2 test at ebb203f).
--
-- The deadlock: a sign-in that ADOPTS a guest customer row already holds that row (the core updates it before it
-- calls the function) and then waited for the guest identity; a concurrent sign-in at another brand with the same
-- verified email locked the guest identity first and then waited for that same customer row to re-point it.
-- The order is now: the guest's customer rows first (FOR UPDATE SKIP LOCKED), the identity second. When another
-- transaction holds any of the guest's customer rows, the merge is left to that transaction (contention is
-- ambiguity: no merge, as decided on #504) — no lock cycle is possible, and a guest is still never merged twice
-- (the merge UPDATE keeps `merged_into_id IS NULL`). The re-point also carries `organization_id = v_org`
-- (defense in depth; RLS already covered it). Everything else is 0196's function unchanged.
CREATE OR REPLACE FUNCTION app.link_customer_identity(
  p_customer_id uuid, p_subject text, p_email_hash text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
SET app.scope = 'organization' AS $$
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
BEGIN
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
  RETURN v_identity;
END $$;

-- CREATE OR REPLACE keeps 0196's grants; restated so the file stands alone.
REVOKE ALL ON FUNCTION app.link_customer_identity(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.link_customer_identity(uuid, text, text) TO platform_app;
