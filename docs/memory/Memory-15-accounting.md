# Memory 15 — Automatic accounting

Window: 15 · Key: `accounting` · Branch prefix: `accounting/` · Model: strongest
Last updated: 2026-09-04 · Contracts: (not tagged yet) · Last commit: (none) · Status: not started

## Identity (does not change)

Owned paths (write):

- `apps/accounting/**`
  Reads:
- packages/events (events-v1)
- docs/domain.md
  Never touches:
- core internals

## Mission — Phase 4 (Events, accounting, CRM)

Double-entry ledger from events: chart of accounts per legal entity, journal entries for revenue/COGS/tax/PSP fees/shipping/refunds/chargebacks, PSP payout reconciliation, ERP sync, Finance-only read API. Replaying one month balances and matches PSP payouts to the cent.

## Done

- (nothing yet)

## In progress

- (nothing yet)

## Next — Phase 4

- [ ] Chart of accounts + legal entities
- [ ] Posting rules per event type
- [ ] Reconciliation against PSP payout reports
- [ ] ERP sync adapter
- [ ] Finance read API + tests

## Decisions made (with reasons)

- (none yet)

## Blocked / waiting

- (none)

## Gotchas learned

- (none yet)

## How to run & test this package

- (fill in after first setup: exact commands)
