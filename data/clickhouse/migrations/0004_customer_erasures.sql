-- customer_erasures (#623): the customers whose identifiers the analytics store must not keep.
--
-- Written by apps/analytics-ingest when it consumes customer.erased, loaded by every ingest at start, and consulted
-- for every row it inserts, so a replay can never put an erased customer's email_hash or customer_id back (the row is
-- scrubbed before it is buffered). It holds NO raw identifier: `digest` is HMAC-SHA256 under ANALYTICS_ERASURE_KEY
-- of `<store_id>:<kind>:<value>` (kind = email | customer | identity; store `*` = every store of the organization),
-- so without the key the list links to nobody.
CREATE TABLE IF NOT EXISTS customer_erasures
(
    digest           String,
    organization_id  UUID,
    event_id         UUID,
    erased_at        DateTime64(3, 'UTC'),
    recorded_at      DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(recorded_at)
ORDER BY digest;
