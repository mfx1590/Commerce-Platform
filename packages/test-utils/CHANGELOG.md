# Changelog — @platform/test-utils

## 0.2.0 — 2026-11-05 (#633, main window on integration/phase5-633-month)

- Additive, opt-in: `generateMonth({ richPayments: true })` (+ `failedRate`, `splitCaptureRate`, `payoutArrival`). It
  adds failed payments (half retried and captured, half never captured with nothing downstream), split captures (two
  payments summing to the order total) and a month-end PSP payout per legal entity in accounting's payout-fixture shape
  (`payouts`). The default month is byte-identical to 0.1.0.
- `GeneratedStream` gains `failures`, `retried`, `splitCaptures` (0 by default) and `payouts` (`[]` by default).
- New builders/types: `paymentFailed`, `monthEndPayouts`, `MonthPayoutFile`, `MonthPayoutLine`.
- Tests: `test/event-month.test.ts` (+5, pure: determinism, opt-in, invariants, payouts); `test/core-month.test.ts`
  (+2: writeMonthToCoreDb's payment-status precedence on the richer month, failed-only orders out of rpt_sales_daily).

## Unreleased — integration/phase5-reconcile (#602, window 12 under the integration exception)

- `writeMonthToCoreDb` + `assertThrowawayCoreDatabase` + `NotAThrowawayDatabaseError` (`src/core-month.ts`): the generated
  month projected into the core rows the reporting views read, a throwaway database only; `test/core-month.test.ts`
  (6) and `vitest.config.ts` (the DATABASE_URL* defaults, as in apps/engagement).

## 0.1.0 — 2026-09-04

- Scaffold created by the main window (Phase 0).
