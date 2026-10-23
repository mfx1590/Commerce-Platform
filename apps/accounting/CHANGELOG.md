# Changelog — @platform/accounting

## 0.3.0 — 2026-10-23 (#549, 15.2)

- Payout reconciliation (`src/reconcile`): `PayoutSource` with a fixture implementation (Stripe itemized-report shape,
  integer minor), the pure matcher (charge by payment intent / charge id with gross and fee, refund by refund id,
  Σ net = payout amount, per-provider ledger window for missing lines), four discrepancy kinds as JSON lines,
  the `bank` posting (Dr 1000 / Cr 1100, `store_id` NULL: a legal-entity-level line) only on a clean match,
  idempotent imports (`psp_payout`, `psp_payout_line`).
- Fixtures `fixtures/payouts/{clean-month,discrepant-month}` built deterministically by `pnpm fixtures:payouts`
  (seeded ids in the event generator: `deterministicIds`, `nullFeeRate`, `ordersPerDay`).
- CLI `pnpm reconcile -- --fixtures <dir> --legal-entity <uuid> [--payout <id>]`.
- The ledger handler takes `pg_advisory_xact_lock(hashtext(order_id))` at the top of its transaction: a shipment parked
  at the same moment as its order.placed on another instance can no longer be orphaned (Fable review of #567, (a));
  tested with 12 shipment / order races. Header of `shipment-shipped.ts` says parking, not retry-then-DLQ.
- Fix (Fable review of #571): the window start of a payout came from every OTHER payout of the provider, later ones
  included, so a re-import of an older discrepant payout saw an empty window, came out clean and posted its bank
  entry; now only payouts strictly earlier by (arrival_date, payout id) count, `reconcileAll` sorts oldest first, and a
  second-pass test pins it. README: import order, fee/adjustment rows as `unmatched_charge`, stale lines on a
  shorter re-import.
- Tests: 55 (+11: the race above, the second pass; fixtures, matcher, the clean month to the cent with the clearing account equal to the open balance,
  the discrepant month with each kind exactly once).

## 0.2.0 — 2026-10-23 (#548, 15.1)

- The ledger consumer: group `accounting.ledger` on the events-v1 consumer SDK over `order.placed`, `order.cancelled`,
  `payment.captured`, `refund.issued`, `shipment.shipped`; one transaction per event (projection → pure posting →
  `ledger_entry` rows → `ctx.markProcessed(tx)` in the shared `consumer_processed` table), `UNIQUE (source_event_id,
account_code)` as the second guard. An event that arrives before its order (separate partitions) is PARKED in
  `accounting_parked_event` with its mark and applied by the order.placed handler in occurred_at order (manager change
  on the plan); the DLQ is for real failures only (5 attempts, then `dlq.accounting.ledger`).
- Posting rules (revenue at shipment, manager decision 2026-10-23): placed = receivable vs contract liability (goods,
  shipping) + VAT; shipped = release per line `floor(net × shipped / qty)` cumulative + shipping with the first
  shipment + carrier cost; captured = PSP clearing (amount − fee) + PSP fees vs receivable; refund = revenue + VAT in
  the order's proportion vs PSP clearing (`cancellation`: receivable vs PSP clearing); cancelled = the unreleased
  remainder reversed. Balanced per currency by construction; no FX.
- The default chart of accounts (12 accounts, codes 1000–6100), seeded per legal entity into `ledger_account`.
- Projections: `accounting_order` / `accounting_order_line` (the ledger's own view of an order), `accounting_payment`,
  `accounting_refund` (provider ids for #549).
- Tables: packages/db 0203 (CONTRACT CHANGE #558, landed as db 0.3.17 by the manager, revision 3 after a Fable
  review: every accounting table `organization_only`, `ledger_entry.store_id` nullable for legal-entity-level lines,
  immutability by grants) and the shared 0202 `consumer_processed`.
- Process: `src/main.ts` with `GET /health`, scripts `dev` / `start` / `once`; the Docker image switches from the
  scaffold health server to the worker through the `start` script.
- Tests: 40 (pure posting + a generated 1,464-event month; a seeded throwaway database; the local broker).

## 0.1.0 — 2026-09-04

- Scaffold created by the main window (Phase 0).
