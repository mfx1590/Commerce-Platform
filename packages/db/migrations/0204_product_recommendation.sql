-- Landed from CONTRACT CHANGE #607 (window 9, task P5.8), manager decision 2026-10-25; amended by the manager:
-- UNIQUE NULLS NOT DISTINCT instead of two partial indexes, and composite foreign keys so a recommendation can
-- never point at another store's product (defence in depth under the job's own same-store filter).
--
-- 0204 recommendations: `product_recommendation` holds what the nightly `index-recommendations` job computed from
-- ClickHouse `fct_order_line` (window 12's #601, read-only user). Two kinds, one table:
--
--   kind              product_id   window_days   score                    meaning
--   bought_together   the anchor   0             lift (ratio, > 1)        people who bought the anchor also bought
--                                                                         related_product_id, above the configured
--                                                                         minimum support
--   popular           NULL         7 or 30       units sold in the window the store's best sellers; store-wide, so
--                                                                         it is stored once per store, not per product
--
-- `score` is a ratio for one kind and a count for the other, so it is `numeric`, not a money or integer column.
-- No money, no customer id, no order id, no PII of any kind reaches this table: product ids and numbers only.
--
-- The job REWRITES per (store, kind, window_days) inside one transaction (DELETE then INSERT), which makes a re-run
-- idempotent and makes a pair that fell below the support threshold disappear instead of lingering. Rows are never
-- updated in place, so UPDATE is revoked for the app role.
--
-- Same-store by construction: (store_id, product_id) and (store_id, related_product_id) reference
-- product (store_id, id). product.id is already the primary key, so the new unique index on (store_id, id) adds no
-- constraint on product, only a target for the composite keys. product_id NULL (the popular list) skips its key
-- (MATCH SIMPLE).

CREATE UNIQUE INDEX IF NOT EXISTS product_store_id_id_key ON product (store_id, id);

CREATE TABLE product_recommendation (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organization(id),
  store_id            uuid NOT NULL REFERENCES store(id),
  product_id          uuid,                                                -- NULL = the store-wide popular list
  related_product_id  uuid NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('bought_together', 'popular')),
  window_days         smallint NOT NULL DEFAULT 0 CHECK (window_days IN (0, 7, 30)),
  score               numeric NOT NULL CHECK (score > 0),
  computed_at         timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (store_id, product_id) REFERENCES product (store_id, id) ON DELETE CASCADE,
  FOREIGN KEY (store_id, related_product_id) REFERENCES product (store_id, id) ON DELETE CASCADE,
  -- a popular row is store-wide and windowed; a bought_together row is anchored and not windowed
  CHECK ((kind = 'popular') = (product_id IS NULL)),
  CHECK ((kind = 'popular') = (window_days <> 0)),
  -- never recommend the product itself
  CHECK (product_id IS NULL OR product_id <> related_product_id),
  -- One row per (store, kind, window, anchor, related). NULLS NOT DISTINCT (Postgres 15+) is what makes the
  -- store-wide popular rows collide: their anchor is NULL, and under the default NULLS DISTINCT two identical
  -- popular rows would both be accepted, so a write that is not a clean DELETE+INSERT could duplicate the list.
  UNIQUE NULLS NOT DISTINCT (store_id, kind, window_days, product_id, related_product_id)
);

-- The read path: one anchor's list, best score first (the rail asks for at most 24). Same leading columns as the
-- unique constraint, with score for the ordering.
CREATE INDEX product_recommendation_read_idx
  ON product_recommendation (store_id, kind, window_days, product_id, score DESC);

-- The composite keys' referencing side (a product delete cascades through it).
CREATE INDEX product_recommendation_related_idx ON product_recommendation (store_id, related_product_id);

SELECT app.apply_rls('product_recommendation', 'store');

-- Rows are rewritten, never updated (see the header).
REVOKE UPDATE ON product_recommendation FROM platform_app;
