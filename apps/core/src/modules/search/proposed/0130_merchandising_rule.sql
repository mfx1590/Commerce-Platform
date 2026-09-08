-- PROPOSED (CONTRACT CHANGE, window 9, task 2.2): packages/db/migrations/0130_merchandising_rule.sql
-- Kept here verbatim until the main window applies it. The search module's tests run this file on their
-- throwaway database so the SQL and the Postgres repository are proven before the migration lands.
--
-- 0130 merchandising_rule: pin / boost / bury per category or search query, per store (docs/plan 2.2, window 9).
-- One rule per (store, scope); rules are pushed to the store's Algolia index as Algolia Rules on publish.
-- Grants come from the 0009 ALTER DEFAULT PRIVILEGES (no sequences: uuid keys).
CREATE TABLE merchandising_rule (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  store_id        uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  scope_type      text NOT NULL CHECK (scope_type IN ('category', 'query')),
  -- category: the product_category id; query: the search query, trimmed and lower-cased
  scope_key       text NOT NULL,
  category_id     uuid REFERENCES product_category(id) ON DELETE CASCADE,
  -- ordered product ids shown first
  pins            jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- [{ product_id, weight 1..100 }]
  boosts          jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- product ids hidden for this scope
  buries          jsonb NOT NULL DEFAULT '[]'::jsonb,
  enabled         boolean NOT NULL DEFAULT true,
  starts_at       timestamptz,
  ends_at         timestamptz,
  published_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(pins) = 'array' AND jsonb_typeof(boosts) = 'array' AND jsonb_typeof(buries) = 'array'),
  CHECK ((scope_type = 'category') = (category_id IS NOT NULL)),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at),
  UNIQUE (store_id, scope_type, scope_key)
);
CREATE INDEX merchandising_rule_store_idx ON merchandising_rule (store_id, updated_at DESC);

SELECT app.apply_rls('merchandising_rule', 'store');
CREATE TRIGGER set_updated_at BEFORE UPDATE ON merchandising_rule
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
