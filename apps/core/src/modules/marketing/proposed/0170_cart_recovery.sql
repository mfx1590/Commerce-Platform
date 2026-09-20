-- PROPOSED (CONTRACT CHANGE, window 17, task 2.4 / #148): packages/db/migrations/0170_cart_recovery.sql.
--
-- Kept here verbatim until the main window applies it. The marketing module's tests apply this file to their own
-- throwaway database, so the code is exercised against exactly the schema being proposed — the pattern window 9
-- used for `merchandising_rule` (#162). When it lands on main, this copy and the test-side DDL are deleted in a
-- small follow-up.
--
-- Two tables:
--   * `cart_recovery` — one row per abandoned cart, its recovery token, and what became of it.
--   * `marketing_cursor` — where marketing's outbox consumers have read up to, per store.
--
-- Why the cursor is a table: window 9 parked its sync cursor in Algolia's index settings *because* packages/db
-- was frozen and it had an external store to hide one in. Marketing has none, and a consumer whose position is
-- not durable re-processes the whole outbox on every restart. It belongs in the database.

-- ---------------------------------------------------------------- cart_recovery
CREATE TABLE cart_recovery (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organization(id),
  store_id           uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  cart_id            uuid NOT NULL REFERENCES cart(id) ON DELETE CASCADE,
  customer_id        uuid REFERENCES customer(id),
  -- sha256 of the lowercased email, exactly as `cart.abandoned` carries it. Never the address itself: this row
  -- is read by a report and exported to a messaging worker, and neither needs to know who the person is.
  email_hash         text,
  currency           char(3) NOT NULL,
  total_minor        bigint NOT NULL CHECK (total_minor >= 0),
  line_item_count    integer NOT NULL CHECK (line_item_count > 0),
  abandoned_at       timestamptz NOT NULL,
  has_attribution    boolean NOT NULL DEFAULT false,
  -- sha256 of the recovery token. The plaintext is returned once, at mint, and never stored — same treatment as
  -- `store_api_key.key_hash`. A database leak must not hand anyone a working set of recovery links.
  token_hash         text NOT NULL,
  token_expires_at   timestamptz NOT NULL,
  redeemed_at        timestamptz,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','redeemed','recovered')),
  recovered_order_id uuid REFERENCES "order"(id) ON DELETE SET NULL,
  recovered_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- The replay guard. `cart.abandoned` can be re-delivered or the consumer re-run from an older cursor; the
  -- schema, not the consumer's memory, is what makes a second record impossible (#148: "one recovery record
  -- per cart").
  UNIQUE (cart_id),
  UNIQUE (token_hash),
  CHECK ((status = 'recovered') = (recovered_at IS NOT NULL))
  -- Deliberately NO `CHECK (redeemed_at >= created_at)`: `created_at` is the database's now() and
  -- `redeemed_at` comes from the application (injectable clock), so the constraint compares two clocks and
  -- fails on ordinary skew between the app host and Postgres. Found by the tests before this shipped.
);
CREATE INDEX cart_recovery_store_status_idx ON cart_recovery (store_id, status, abandoned_at DESC);
CREATE INDEX cart_recovery_store_abandoned_idx ON cart_recovery (store_id, abandoned_at DESC);
CREATE INDEX cart_recovery_order_idx ON cart_recovery (recovered_order_id) WHERE recovered_order_id IS NOT NULL;

-- `expired` is deliberately NOT a status: it is `status = 'pending' AND token_expires_at < now()`, true the
-- moment it is true, with no job to run and no row to drift out of date. A status column that needs a cron to
-- stay honest is a bug waiting for an outage.

-- ---------------------------------------------------------------- marketing_cursor
CREATE TABLE marketing_cursor (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  store_id        uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  -- Consumer name, e.g. `cart_recovery`. One row per (store, consumer) so a second consumer added later does
  -- not have to share a position with this one.
  name            text NOT NULL,
  seq             bigint NOT NULL DEFAULT 0 CHECK (seq >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, name)
);

-- ---------------------------------------------------------------- RLS (ADR 0001) + updated_at triggers
SELECT app.apply_rls(t, 'store') FROM unnest(ARRAY['cart_recovery','marketing_cursor']) AS t;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cart_recovery','marketing_cursor'] LOOP
    EXECUTE format('CREATE TRIGGER set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION app.set_updated_at()', t);
  END LOOP;
END $$;
