# @platform/test-utils

Shared test fixtures and factories: brand/store/product/order factories with deterministic IDs, a Postgres test-database helper (creates a throwaway database per test file), and an events assertion helper.

See CLAUDE.md for run/test commands and the public API. Owner: main window..

## Event streams (since 2026-10-25)

`generateMonth` and the event builders (`orderPlaced`, `paymentCaptured`, `refundIssued`, `shipmentShipped`, `orderCancelled`, ...)
produce real, schema-validated envelopes with the seed ids: a business-consistent month (refunds, cancellations,
parking, three brands) for the accounting gate (#552), the analytics models (#601), the reconcile (#602) and
recommendations (#607). Moved from apps/accounting/src/posting/fixtures.ts, which re-exports it unchanged. Deterministic
with a seed (`withSeededIds`, `rng`). No PII: `email_hash` is a hash of a fixture address.

## The month in the core tables (#602)

`writeMonthToCoreDb(ownerPool, events)` projects a generated month into the core rows the reporting views read
(`"order"`, `payment`, `refund`, and an order's `cancelled` status), so `rpt_sales_daily` / `rpt_payments_daily` /
`rpt_refunds_daily` can be compared with ClickHouse on the CI month. It is a pure projection: every amount is copied
from the event that carries it, nothing is computed or re-derived, and no business rule applies. Columns no report
reads and no event carries get neutral fixture values (`projection+<order_id>@example.test`, addresses holding only
the payload's country, the store's first sales channel, a display id numbered by the core's trigger). It writes
through the OWNER pool and only into a throwaway database (`assertThrowawayCoreDatabase`: a `createTestDatabase`
name, never a shared dev name, #595 pattern). `test/core-month.test.ts` proves it: the projected month's views return
exactly the events' counts and minor-unit sums (sales with cohort refunds, captures with known and unknown fees,
refunds by reason and issue day). Needs Postgres (skipped with a printed reason otherwise).
