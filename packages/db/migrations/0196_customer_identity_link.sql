-- Landed from CONTRACT CHANGE #504 (window 13, task 13.4 / #473), manager decision 2026-10-18.
-- The SQL below is the proposed file with the manager's five conditions applied (they override the proposal):
--   1. Neither function trusts its arguments. The organization is the caller's own `app.organization_id`, not a
--      parameter, and the target customer row is read first: absent, in another organization, or (when the
--      caller's `app.store_ids` is non-empty, i.e. every store-scoped session) outside the caller's stores →
--      SQLSTATE 42501. An empty `app.store_ids` is an organization-scope caller (eraseIdentity) and is allowed.
--      The function's SET clause changes only `app.scope`, so the caller's `app.store_ids` is still visible inside.
--   2. The guest merge is race-safe: the candidates are locked FOR UPDATE before they are counted, the merge UPDATE
--      carries `AND merged_into_id IS NULL`, and customers are re-pointed only when that UPDATE hit a row.
--   5. The DROP CONSTRAINT name was checked in pg_constraint on the dev database; apply_rls (0192's definition)
--      drops the existing `tenant_isolation` policy before it creates the new one, so the `organization` policy
--      from 0009 is replaced, not OR-ed with the new one.
--
-- 0196 customer_identity: the cross-brand link, written at last (CONTRACT CHANGE #504, window 13 #473; manager
-- decisions 2026-10-18: key = the customers-realm subject only; two subjects with the same verified email are two
-- identities; a guest-only identity is merged by email_hash only when exactly ONE subjectless candidate matches).
--
-- 1. Closed to store sessions: `organization_only` (0192's kind) — a store session can neither SELECT nor write
--    the table (risk 1: a brand must never learn that a person shops at another brand). HQ / organization sessions
--    read it; the core writes it through the two SECURITY DEFINER functions below.
SELECT app.apply_rls('customer_identity', 'organization_only');

-- 2. Key = subject. email_hash stays (BI joins, the guest merge) but is no longer unique: two Keycloak accounts
--    with the same verified email are two people as far as this table knows (a shared mailbox).
--    (0002 declared the UNIQUE inline, so Postgres named it; the name below is the one pg_constraint shows on dev.)
ALTER TABLE customer_identity DROP CONSTRAINT customer_identity_organization_id_email_hash_key;
CREATE INDEX customer_identity_email_hash_idx ON customer_identity (organization_id, email_hash);
CREATE UNIQUE INDEX customer_identity_subject_key ON customer_identity (organization_id, keycloak_subject)
  WHERE keycloak_subject IS NOT NULL;

-- 3. The writer. Runs in organization scope (0191's pattern: the scope is the function's own SET clause, restored
--    on return AND on error) so a store session can link without seeing the table. Returns the identity id and
--    nothing else. Called by the core INSIDE the provisioning transaction, only for a VERIFIED email.
--    - scope: the target customer must be in the caller's organization and, for a store-scoped caller, in one of
--      the caller's stores (condition 1) — otherwise 42501 and nothing is written;
--    - by subject: the identity exists → reuse; else create (email_hash = sha256 of the lowercased verified email);
--    - guest merge: when a subjectless, unmerged identity with this email_hash exists, it is merged into the
--      subject identity (merged_into_id) and every customer pointing at it is re-pointed — ONLY when exactly one
--      such candidate exists; two or more → no merge (ambiguity is never guessed). The candidates are locked
--      before they are counted, and a guest another transaction merged first is never merged again (condition 2);
--    - the customer row is pointed at the identity (customer.identity_id).
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
  -- the guest merge: exactly one subjectless, unmerged identity with this email_hash; two or more → no merge.
  -- Lock the candidates first, so a concurrent link with the same email_hash waits here and then re-checks them.
  PERFORM 1 FROM customer_identity
   WHERE organization_id = v_org AND email_hash = p_email_hash
     AND keycloak_subject IS NULL AND merged_into_id IS NULL AND id <> v_identity
   FOR UPDATE;
  SELECT count(*) INTO v_guests FROM customer_identity
   WHERE organization_id = v_org AND email_hash = p_email_hash
     AND keycloak_subject IS NULL AND merged_into_id IS NULL AND id <> v_identity;
  IF v_guests = 1 THEN
    SELECT id INTO v_guest FROM customer_identity
     WHERE organization_id = v_org AND email_hash = p_email_hash
       AND keycloak_subject IS NULL AND merged_into_id IS NULL AND id <> v_identity;
    UPDATE customer_identity SET merged_into_id = v_identity, updated_at = now()
     WHERE id = v_guest AND merged_into_id IS NULL;
    GET DIAGNOSTICS v_merged = ROW_COUNT;
    IF v_merged = 1 THEN
      UPDATE customer SET identity_id = v_identity WHERE identity_id = v_guest;
    END IF;
  END IF;
  UPDATE customer SET identity_id = v_identity
   WHERE id = p_customer_id AND organization_id = v_org AND identity_id IS DISTINCT FROM v_identity;
  RETURN v_identity;
END $$;

-- 4. The unlinker, for erasure (replaces the core's savepoint trick, which cannot see the table any more):
--    clears customer.identity_id and deletes the identity when nothing references it any more (another brand's
--    row of the same person, or a merged identity, keeps it). Returns true when the identity row was deleted.
--    Same scope rule as the writer (condition 1): a customer outside the caller's scope → 42501, nothing changes.
CREATE OR REPLACE FUNCTION app.unlink_customer_identity(p_customer_id uuid)
RETURNS boolean
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
BEGIN
  SELECT c.id, c.organization_id, c.store_id, c.identity_id
    INTO v_customer, v_customer_org, v_customer_store, v_identity
    FROM customer c WHERE c.id = p_customer_id FOR NO KEY UPDATE;
  IF v_customer IS NULL OR v_customer_org <> v_org
     OR (v_store_ids <> '' AND NOT (v_customer_store = ANY (string_to_array(v_store_ids, ',')::uuid[]))) THEN
    RAISE EXCEPTION 'unlink_customer_identity: the customer is not in this session''s scope'
      USING ERRCODE = '42501';
  END IF;
  IF v_identity IS NULL THEN
    RETURN false;
  END IF;
  UPDATE customer SET identity_id = NULL WHERE id = p_customer_id;
  DELETE FROM customer_identity ci
   WHERE ci.id = v_identity
     AND NOT EXISTS (SELECT 1 FROM customer c WHERE c.identity_id = v_identity)
     AND NOT EXISTS (SELECT 1 FROM customer_identity m WHERE m.merged_into_id = v_identity);
  RETURN FOUND;
END $$;

-- 0110's pattern for a callable SECURITY DEFINER function: nobody but the application role may call it.
REVOKE ALL ON FUNCTION app.link_customer_identity(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.unlink_customer_identity(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.link_customer_identity(uuid, text, text) TO platform_app;
GRANT EXECUTE ON FUNCTION app.unlink_customer_identity(uuid) TO platform_app;
