# Changelog — @platform/test-utils

## Unreleased — integration/phase5-reconcile (#602, window 12 under the integration exception)

- `writeMonthToCoreDb` + `assertThrowawayCoreDatabase` + `NotAThrowawayDatabaseError` (`src/core-month.ts`): the generated
  month projected into the core rows the reporting views read, a throwaway database only; `test/core-month.test.ts`
  (6) and `vitest.config.ts` (the DATABASE_URL* defaults, as in apps/engagement).

## 0.1.0 — 2026-09-04

- Scaffold created by the main window (Phase 0).
