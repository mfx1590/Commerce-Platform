# @platform/test-utils

Shared test fixtures and factories: brand/store/product/order factories with deterministic IDs, a Postgres test-database helper (creates a throwaway database per test file), and an events assertion helper.

See CLAUDE.md for run/test commands and the public API. Owner: main window..

## Event streams (since 2026-10-25)

`generateMonth` and the event builders (`orderPlaced`, `paymentCaptured`, `refundIssued`, `shipmentShipped`, `orderCancelled`, ...)
produce real, schema-validated envelopes with the seed ids: a business-consistent month (refunds, cancellations,
parking, three brands) for the accounting gate (#552), the analytics models (#601), the reconcile (#602) and
recommendations (#607). Moved from apps/accounting/src/posting/fixtures.ts, which re-exports it unchanged. Deterministic
with a seed (`withSeededIds`, `rng`). No PII: `email_hash` is a hash of a fixture address.
