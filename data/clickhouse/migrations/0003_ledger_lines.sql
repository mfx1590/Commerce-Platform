-- ledger_lines (#602, D7 as amended 2026-10-25): a COPY of the ledger's own posted journal lines, pulled through the
-- Finance API (`listJournalLines`, apps/accounting) by `reconcile`. ClickHouse never recomputes revenue: these rows
-- are what the ledger posted, line for line, so recognised revenue (4000 + 4010 + 4090) can be checked for copy
-- integrity, lineage back to raw_events and the lifetime invariant, with no posting rule copied into data/**.
--
-- A re-pull inserts the same line ids again; ReplacingMergeTree keyed (legal_entity_id, id) folds them, the latest
-- pull (pulled_at) wins. Amounts are integer minor units beside their currency, never summed across currencies.
CREATE TABLE IF NOT EXISTS ledger_lines
(
    id               UUID,
    legal_entity_id  UUID,
    store_id         Nullable(UUID),
    journal          LowCardinality(String),
    entry_date       Date,
    account_code     LowCardinality(String),
    debit_minor      Int64,
    credit_minor     Int64,
    currency         LowCardinality(String),
    source_event_id  UUID,
    source_topic     LowCardinality(String),
    reference_type   LowCardinality(String),
    reference_id     UUID,
    pulled_at        DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(pulled_at)
PARTITION BY toYYYYMM(entry_date)
ORDER BY (legal_entity_id, id);
