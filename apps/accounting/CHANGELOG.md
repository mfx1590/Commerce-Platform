# Changelog — @platform/accounting

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
