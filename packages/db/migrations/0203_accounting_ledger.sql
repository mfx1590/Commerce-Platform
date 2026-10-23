-- 0203 accounting ledger tables — CONTRACT CHANGE #558 (window 15, for #548 ledger consumer and #549 payout
-- reconciliation), revision 3 after the manager's Fable review (2026-10-23). PROPOSED by window 15; the manager lands
-- this file verbatim in packages/db (integration landing). Until then the accounting tests apply it to their own
-- throwaway database (test/helpers/db.ts skips it once `ledger_account` exists); the copy under apps/accounting is
-- deleted when it is on main.
--
-- Needs 0008 (ledger_entry), 0009 / 0192 (app.apply_rls incl. the `organization_only` kind), 0002/0003
-- (legal_entity, store); 0202 (consumer_processed) is the processed store the consumer marks in the same transaction.
--
-- Three rules this file sets (manager decisions on the review):
--   * RLS: EVERY accounting table, ledger_entry included, is `organization_only` — a store-scoped session reads and
--     writes none. Accounting is an HQ function (master plan RBAC: `finance` on the organization); a store admin never
--     sees a legal entity's books or payouts. The accounting service runs in organization scope.
--   * Store attribution: a ledger line that a store's fact caused (order, payment, refund, shipment) carries that
--     store_id; a legal-entity-level line (a payout, a bank movement) carries store_id NULL. Hence the DROP NOT NULL.
--   * Immutability in SQL, not in code: the application role can never DELETE a ledger line, an account, a payout line
--     or a payment / refund projection, and can UPDATE a ledger line only in its ERP columns. Parked events keep
--     DELETE (they are deleted when the order applies them).
--
-- Known limit: cross-tenant consistency of legal_entity_id / organization_id inside a payload (an event claiming a
-- legal entity of another organization) is the consumer's to check; RLS fences the reads and writes to the session's
-- organization, it does not validate the pairing.

-- 1. ledger_account — the chart of accounts, one row per (legal entity, code). The ledger consumer seeds its default
--    chart for a legal entity the first time it posts for it (INSERT … ON CONFLICT DO NOTHING); the owner's accountant
--    renames or extends it before launch.
CREATE TABLE ledger_account (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organization(id),
  legal_entity_id  uuid NOT NULL REFERENCES legal_entity(id),
  code             text NOT NULL,
  name             text NOT NULL,
  type             text NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
  is_active        boolean NOT NULL DEFAULT true,
  -- Odoo account id once mapped (#550); NULL until the ERP sync maps it.
  erp_account_id   integer,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (legal_entity_id, code)
);
SELECT app.apply_rls('ledger_account', 'organization_only');
CREATE TRIGGER set_updated_at BEFORE UPDATE ON ledger_account
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
-- an account is renamed or deactivated, never removed (ledger lines reference its code)
REVOKE DELETE ON ledger_account FROM platform_app;

-- 2. ledger_entry (0008): organization_only RLS (it was store-kind; nothing reads it yet), store_id nullable for
--    legal-entity-level lines, the `bank` journal for payout postings (#549), two indexes — the trial balance groups
--    by (legal entity, currency, account) and the ERP sync (#550) scans the unposted rows per legal entity — and the
--    grants: a posted line is never deleted; only its ERP columns are ever updated (the updated_at trigger sets
--    updated_at itself, so the column grant on it is for completeness).
SELECT app.apply_rls('ledger_entry', 'organization_only');
ALTER TABLE ledger_entry ALTER COLUMN store_id DROP NOT NULL;
ALTER TABLE ledger_entry DROP CONSTRAINT ledger_entry_journal_check;
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_journal_check
  CHECK (journal IN ('sales', 'psp_fees', 'refunds', 'cogs', 'tax', 'shipping', 'bank'));
CREATE INDEX ledger_entry_balance_idx ON ledger_entry (legal_entity_id, currency, account_code);
CREATE INDEX ledger_entry_unposted_idx ON ledger_entry (legal_entity_id, created_at) WHERE posted_to_erp_at IS NULL;
REVOKE UPDATE, DELETE ON ledger_entry FROM platform_app;
GRANT UPDATE (posted_to_erp_at, erp_reference, updated_at) ON ledger_entry TO platform_app;

-- 3. The ledger's OWN projection of an order, built from `order.placed` only (ADR 0003 item 6: the accounting service
--    never reads core tables). What the later events need: the net amount per line and how much of it has already
--    been released to revenue (shipment.shipped, partial shipments), the order's VAT and shipping (refund.issued,
--    order.cancelled). `order_id` is the payload's id, not a FK: a projection outlives nothing and references nothing.
CREATE TABLE accounting_order (
  order_id              uuid PRIMARY KEY,
  organization_id       uuid NOT NULL REFERENCES organization(id),
  store_id              uuid NOT NULL REFERENCES store(id),
  legal_entity_id       uuid NOT NULL REFERENCES legal_entity(id),
  display_id            integer NOT NULL,
  currency              char(3) NOT NULL,
  -- totals.total_minor: the gross receivable posted at placement
  total_minor           bigint NOT NULL,
  -- totals.tax_minor: the VAT payable posted at placement
  tax_minor             bigint NOT NULL,
  -- Σ line (total_minor − tax_minor): contract liability — goods
  goods_net_minor       bigint NOT NULL,
  -- total − tax − goods net: contract liability — shipping (net of its tax in tax-inclusive stores)
  shipping_net_minor    bigint NOT NULL,
  -- goods released to revenue so far (Σ accounting_order_line.released_minor); = goods_net_minor once fully shipped
  goods_released_minor  bigint NOT NULL DEFAULT 0,
  -- shipping is released with the FIRST shipment of the order
  shipping_released     boolean NOT NULL DEFAULT false,
  status                text NOT NULL DEFAULT 'placed' CHECK (status IN ('placed', 'cancelled')),
  placed_at             timestamptz NOT NULL,
  cancelled_at          timestamptz,
  -- outbox id of the order.placed event this row was built from
  source_event_id       uuid NOT NULL UNIQUE,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CHECK (goods_released_minor BETWEEN 0 AND goods_net_minor OR goods_net_minor < 0)
);
CREATE INDEX accounting_order_entity_idx ON accounting_order (legal_entity_id, placed_at);
SELECT app.apply_rls('accounting_order', 'organization_only');
CREATE TRIGGER set_updated_at BEFORE UPDATE ON accounting_order
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE accounting_order_line (
  order_line_item_id  uuid PRIMARY KEY,
  order_id            uuid NOT NULL REFERENCES accounting_order(order_id) ON DELETE CASCADE,
  organization_id     uuid NOT NULL REFERENCES organization(id),
  store_id            uuid NOT NULL REFERENCES store(id),
  quantity            integer NOT NULL CHECK (quantity >= 1),
  -- the line's total_minor − tax_minor (net of VAT in both price modes)
  net_minor           bigint NOT NULL,
  -- a shipment of more than was ordered is a producer defect: the posting fails and the event dead-letters
  shipped_quantity    integer NOT NULL DEFAULT 0 CHECK (shipped_quantity BETWEEN 0 AND quantity),
  -- released = floor(net × shipped / quantity): the remainder of the division lands on the last units shipped
  released_minor      bigint NOT NULL DEFAULT 0 CHECK (released_minor BETWEEN 0 AND net_minor),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX accounting_order_line_order_idx ON accounting_order_line (order_id);
SELECT app.apply_rls('accounting_order_line', 'organization_only');
CREATE TRIGGER set_updated_at BEFORE UPDATE ON accounting_order_line
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- 3b. Parked events (manager decision 2026-10-23 on the #548 plan): the five topics are separate partitions, so a
--     shipment.shipped, a refund.issued or an order.cancelled routinely reaches the consumer BEFORE its order.placed
--     (a replay into a fresh group reads all topics at once). Such an event is parked — the row and the processed
--     mark commit together — and order.placed applies the order's parked events in occurred_at order inside its own
--     transaction, then deletes them (the application role keeps DELETE here for that). The envelope is the event as
--     published: ids, amounts, hashes, a tracking number at most — never PII (ADR 0003 item 5).
CREATE TABLE accounting_parked_event (
  outbox_id        uuid PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organization(id),
  store_id         uuid NOT NULL REFERENCES store(id),
  topic            text NOT NULL,
  version          integer NOT NULL,
  order_id         uuid NOT NULL,
  occurred_at      timestamptz NOT NULL,
  envelope         jsonb NOT NULL,
  parked_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX accounting_parked_event_order_idx ON accounting_parked_event (order_id, occurred_at, parked_at);
CREATE INDEX accounting_parked_event_age_idx ON accounting_parked_event (organization_id, parked_at);
SELECT app.apply_rls('accounting_parked_event', 'organization_only');

-- 4. Projections of captures and refunds: what payout reconciliation (#549) matches the PSP's balance transactions
--    against — the provider ids live only here (payment.captured carries provider_payment_id, refund.issued carries
--    provider_refund_id; ledger_entry references our own payment / refund ids). Written once, never deleted.
CREATE TABLE accounting_payment (
  payment_id           uuid PRIMARY KEY,
  order_id             uuid NOT NULL,
  organization_id      uuid NOT NULL REFERENCES organization(id),
  store_id             uuid NOT NULL REFERENCES store(id),
  legal_entity_id      uuid NOT NULL REFERENCES legal_entity(id),
  provider             text NOT NULL,
  provider_payment_id  text,
  amount_minor         bigint NOT NULL CHECK (amount_minor > 0),
  -- fee_minor of the event; 0 when the event carried null (matched against the payout report later)
  fee_minor            bigint NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
  currency             char(3) NOT NULL,
  captured_at          timestamptz NOT NULL,
  source_event_id      uuid NOT NULL UNIQUE,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX accounting_payment_provider_idx ON accounting_payment (legal_entity_id, provider, provider_payment_id);
CREATE INDEX accounting_payment_order_idx ON accounting_payment (order_id);
SELECT app.apply_rls('accounting_payment', 'organization_only');
REVOKE DELETE ON accounting_payment FROM platform_app;

CREATE TABLE accounting_refund (
  refund_id            uuid PRIMARY KEY,
  payment_id           uuid NOT NULL,
  order_id             uuid NOT NULL,
  organization_id      uuid NOT NULL REFERENCES organization(id),
  store_id             uuid NOT NULL REFERENCES store(id),
  legal_entity_id      uuid NOT NULL REFERENCES legal_entity(id),
  provider_refund_id   text,
  amount_minor         bigint NOT NULL CHECK (amount_minor > 0),
  currency             char(3) NOT NULL,
  reason               text NOT NULL CHECK (reason IN ('return', 'cancellation', 'goodwill', 'chargeback')),
  issued_at            timestamptz NOT NULL,
  source_event_id      uuid NOT NULL UNIQUE,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX accounting_refund_provider_idx ON accounting_refund (legal_entity_id, provider_refund_id);
CREATE INDEX accounting_refund_order_idx ON accounting_refund (order_id);
SELECT app.apply_rls('accounting_refund', 'organization_only');
REVOKE DELETE ON accounting_refund FROM platform_app;

-- 5. PSP payouts (#549): one row per imported payout report and one per balance transaction in it, with the match
--    against the ledger. A payout belongs to a (legal entity, provider): the PSP account is the legal entity's.
--    Re-importing the same payout is a no-op through the UNIQUE keys. The payout posting (journal `bank`, Dr 1000 /
--    Cr 1100) is a legal-entity-level ledger line: store_id NULL, source_event_id = this row's id, source_topic
--    'psp.payout' (a local marker, not a bus topic).
CREATE TABLE psp_payout (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organization(id),
  legal_entity_id      uuid NOT NULL REFERENCES legal_entity(id),
  provider             text NOT NULL,
  provider_payout_id   text NOT NULL,
  currency             char(3) NOT NULL,
  -- what reached the bank
  amount_minor         bigint NOT NULL,
  arrival_date         date NOT NULL,
  -- imported   = lines stored, not matched yet
  -- reconciled = every line matched to the cent; the payout entry (bank vs PSP clearing) is posted
  -- discrepant = at least one difference; nothing posted until the finance user resolves it
  status               text NOT NULL DEFAULT 'imported' CHECK (status IN ('imported', 'reconciled', 'discrepant')),
  line_count           integer NOT NULL DEFAULT 0 CHECK (line_count >= 0),
  matched_count        integer NOT NULL DEFAULT 0 CHECK (matched_count >= 0),
  -- when the bank entry was written (ledger_entry.source_event_id = this id); only a reconciled payout is posted
  posted_at            timestamptz,
  imported_at          timestamptz NOT NULL DEFAULT now(),
  reconciled_at        timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (legal_entity_id, provider, provider_payout_id),
  CHECK ((status = 'reconciled') = (reconciled_at IS NOT NULL)),
  CHECK (posted_at IS NULL OR status = 'reconciled')
);
CREATE INDEX psp_payout_entity_idx ON psp_payout (legal_entity_id, arrival_date);
SELECT app.apply_rls('psp_payout', 'organization_only');
CREATE TRIGGER set_updated_at BEFORE UPDATE ON psp_payout
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE psp_payout_line (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_id               uuid NOT NULL REFERENCES psp_payout(id) ON DELETE CASCADE,
  organization_id         uuid NOT NULL REFERENCES organization(id),
  legal_entity_id         uuid NOT NULL REFERENCES legal_entity(id),
  -- the PSP's balance-transaction id (Stripe txn_…)
  provider_txn_id         text NOT NULL,
  kind                    text NOT NULL CHECK (kind IN ('charge', 'refund', 'fee', 'adjustment', 'payout', 'other')),
  -- the PSP object the transaction settles: payment intent / charge id, refund id (matched against
  -- accounting_payment.provider_payment_id / accounting_refund.provider_refund_id)
  provider_reference      text,
  amount_minor            bigint NOT NULL,
  fee_minor               bigint NOT NULL DEFAULT 0,
  net_minor               bigint NOT NULL,
  currency                char(3) NOT NULL,
  available_on            date,
  -- what the matcher found: our payment / refund id, and the verdict
  matched_reference_type  text CHECK (matched_reference_type IN ('payment', 'refund')),
  matched_reference_id    uuid,
  match_status            text NOT NULL DEFAULT 'pending'
                          CHECK (match_status IN ('pending', 'matched', 'unmatched', 'amount_mismatch', 'fee_mismatch')),
  -- PSP amount − ledger amount (0 when matched)
  difference_minor        bigint NOT NULL DEFAULT 0,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payout_id, provider_txn_id),
  CHECK ((matched_reference_type IS NULL) = (matched_reference_id IS NULL))
);
CREATE INDEX psp_payout_line_reference_idx ON psp_payout_line (legal_entity_id, provider_reference);
CREATE INDEX psp_payout_line_status_idx ON psp_payout_line (payout_id, match_status);
SELECT app.apply_rls('psp_payout_line', 'organization_only');
CREATE TRIGGER set_updated_at BEFORE UPDATE ON psp_payout_line
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
-- an imported line is re-matched (UPDATE), never removed; a payout row itself is never deleted by the app either
-- (cascade would take its lines) — nothing in the service deletes payouts
REVOKE DELETE ON psp_payout_line FROM platform_app;
