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

## The richer payment month (#633, 0.2.0)

`generateMonth({ ..., richPayments: true })` adds three shapes to the month. It is opt-in: without it the month is
byte-identical to 0.1.0, so every existing caller and the committed accounting payout fixtures are unchanged. The
extra draws come from a second PRNG seeded from `seed`, so the richer month is deterministic too (same options, same
bytes).

- **Failed payments** (`failedRate`, default 0.08 of orders): the order's first payment fails (`payment.failed`, its
  own `payment_id`, a `failure_reason` such as `card_declined`, 20 s after placement). Half of these are never
  captured. They get nothing downstream (no shipment, no refund, no cancellation), and the order stays pending with
  `payment_status 'failed'`, which is how the core leaves it (apps/core payments: capture.ts, webhook-receiver.ts).
  The other half retry with a second payment that is captured.
- **Split captures** (`splitCaptureRate`, default 0.1 of captured orders): two `payment.captured` events with two
  `payment_id`s and two `pi_fixture_…` provider ids (the core captures a payment once, and the ledger keys payments by
  `payment_id`). Between them they capture the order total: 30–70 % at 10:mm and the rest at 11:mm, each with its own
  fee and the order's fee nullness. Refunds reference the first payment.
- **Month-end PSP payouts** (`payouts`, arrival `payoutArrival`, default `2026-10-31`): one report per legal entity
  in apps/accounting's `PayoutFixtureFile` shape (`monthEndPayouts`, `MonthPayoutFile`, `MonthPayoutLine`; built like
  accounting's #549 fixture builder). It has a charge row per capture (available 2 days later; a null fee is 0) and a
  refund row per refund (available that day). The payout carries every row available before the arrival date and
  pays Σ net. A payout is not an event: hand `month.payouts` to accounting's `createFixtureSource` and run
  `reconcileAll` per legal entity once the ledger has consumed the month. Each payout then reconciles to the cent and
  posts Dr 1000 / Cr 1100 (`psp.payout`) on the arrival date, which the Finance API's `listPayouts` serves. That is
  what identity 3c compares (apps/accounting/test/month-payouts.test.ts proves it).

The stream counts them: `failures`, `retried`, `splitCaptures` (each 0 by default) and `payouts` (`[]` by default).
`captures` counts every `payment.captured`, so a split capture counts 2. For the Integration 5 gate's month
(`orders 150, seed 6020, legalEntities 3, ordersPerDay 5, deterministicIds`), `richPayments` gives 548 events: 150
orders, 136 captures, 12 failures (6 retried, 6 never captured), 11 split captures, 48 refunds, 29 cancellations, 173
shipments. Its 3 payouts carry 68 (EUR), 47 (GBP) and 61 (USD) lines.

`writeMonthToCoreDb` projects every `payment.failed` / `payment.captured` into its own `payment` row. The order's
`payment_status` follows this precedence: `captured` if any capture exists (a retried order, and a split capture with
two captured rows), else `failed` if a failure exists, else `awaiting`. `test/core-month.test.ts` exercises all three
on the richer month. It also checks that `rpt_sales_daily` leaves out failed-only orders, as the ClickHouse mart does.
