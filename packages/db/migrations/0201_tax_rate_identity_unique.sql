-- Landed from CONTRACT CHANGE #522 (window 1, #520), manager decision 2026-10-20.
-- 0201 tax_rate identity: one row per (store, country, region, product category). region and
-- product_category_id are nullable (NULL = country-wide / every product), and a plain UNIQUE treats NULLs as
-- distinct, so two country-wide rows would both pass; NULLS NOT DISTINCT (PG 15+) makes a NULL count as a value.
-- The core maps the 23505 on this index to 409 conflict with details.tax_rate_id.
CREATE UNIQUE INDEX tax_rate_identity_key ON tax_rate (store_id, country, region, product_category_id) NULLS NOT DISTINCT;
