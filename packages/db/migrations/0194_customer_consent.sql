-- Landed from CONTRACT CHANGE #489 (window 13, task 13.2 / #471), manager decision 2026-10-18.
-- 0194 customer_consent: the record of truth for a customer's consent decisions (CONTRACT CHANGE #489, window 13
-- #471; manager decisions 2026-10-15/18: purposes = marketing_email only until the lawyer review; per brand, never
-- propagated across stores; append-only). `customer.consent` (0005) stays the current-state projection window 17's
-- segments read; the core rewrites it from the newest ledger row in the same transaction.
CREATE TABLE customer_consent (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  store_id        uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  customer_id     uuid NOT NULL REFERENCES customer(id) ON DELETE CASCADE,
  purpose         text NOT NULL CHECK (purpose IN ('marketing_email')),
  granted         boolean NOT NULL,
  source          text NOT NULL CHECK (source IN ('storefront', 'admin', 'import')),
  policy_version  text NOT NULL CHECK (policy_version <> ''),
  recorded_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_consent_customer_idx ON customer_consent (customer_id, purpose, recorded_at DESC);
SELECT app.apply_rls('customer_consent', 'store');
-- Append-only for the app role (0009's default privileges grant UPDATE; a decision is never edited). DELETE stays:
-- erasure removes the customer's rows.
REVOKE UPDATE ON customer_consent FROM platform_app;

-- Backfill (decided): one ledger row per existing projection, so the ledger is complete from day one. Idempotent:
-- a customer with any ledger row for the purpose is skipped. recorded_at = the projection's own timestamp
-- (`at`), never now(); source from the block (unknown/missing → 'import'); policy_version 'pre-ledger'.
INSERT INTO customer_consent (organization_id, store_id, customer_id, purpose, granted, source, policy_version, recorded_at)
SELECT c.organization_id, c.store_id, c.id, 'marketing_email',
       (c.consent->'marketing_email'->>'granted')::boolean,
       CASE WHEN c.consent->'marketing_email'->>'source' IN ('storefront', 'admin', 'import')
            THEN c.consent->'marketing_email'->>'source' ELSE 'import' END,
       'pre-ledger',
       COALESCE((c.consent->'marketing_email'->>'at')::timestamptz, c.updated_at)
FROM customer c
WHERE c.status <> 'erased'
  AND jsonb_typeof(c.consent->'marketing_email'->'granted') = 'boolean'
  AND NOT EXISTS (SELECT 1 FROM customer_consent x WHERE x.customer_id = c.id AND x.purpose = 'marketing_email');
