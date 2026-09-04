-- 0008 ledger_entry: derived from events only (Phase 4, window 15). Frozen now so events carry what it needs.
CREATE TABLE ledger_entry (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organization(id),
  legal_entity_id  uuid NOT NULL REFERENCES legal_entity(id),
  store_id         uuid NOT NULL REFERENCES store(id),
  journal          text NOT NULL CHECK (journal IN ('sales','psp_fees','refunds','cogs','tax','shipping')),
  entry_date       date NOT NULL,
  account_code     text NOT NULL,
  debit_minor      bigint NOT NULL DEFAULT 0 CHECK (debit_minor >= 0),
  credit_minor     bigint NOT NULL DEFAULT 0 CHECK (credit_minor >= 0),
  currency         char(3) NOT NULL,
  source_event_id  uuid NOT NULL,
  source_topic     text NOT NULL,
  reference_type   text,
  reference_id     uuid,
  posted_to_erp_at timestamptz,
  erp_reference    text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_event_id, account_code),
  CHECK (debit_minor = 0 OR credit_minor = 0)
);
CREATE INDEX ledger_entry_date_idx ON ledger_entry (legal_entity_id, entry_date);
CREATE INDEX ledger_entry_reference_idx ON ledger_entry (reference_type, reference_id);
