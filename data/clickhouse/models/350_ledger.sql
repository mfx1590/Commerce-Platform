-- fct_ledger_line (#602): the ledger's posted lines as pulled (migrations/0003), one row per line id. A copy, never
-- a recomputation (D7): `revenue_minor` is credit − debit, the ledger's own sign convention for a revenue account,
-- and is only meaningful on 4000 (goods), 4010 (shipping) and 4090 (refunds, contra revenue).
CREATE OR REPLACE VIEW fct_ledger_line AS
SELECT
    id,
    legal_entity_id,
    store_id,
    journal,
    entry_date,
    account_code,
    debit_minor,
    credit_minor,
    credit_minor - debit_minor                          AS revenue_minor,
    account_code IN ('4000', '4010', '4090')            AS is_revenue,
    currency,
    source_event_id,
    source_topic,
    reference_type,
    reference_id
FROM ledger_lines FINAL;
