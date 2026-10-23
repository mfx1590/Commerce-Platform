# Memory 15 — Automatic accounting
Window: 15 · Key: `accounting` · Branch prefix: `accounting/` · Model: Fable (strongest; money)
Last updated: 2026-10-23 (manager, kickoff) · Contracts: contracts-v0.4.26, events-v1 = 2abe310 · Last commit: (none) · Status: not started — worktree ../wt-accounting, branch accounting/phase4

## Identity (does not change)
Owned paths (write):
- `apps/accounting/**`
Reads:
- everything; especially packages/events (events-v1 consumer SDK: `createConsumer`, `createPgProcessedStore`, `readDeadLetters`), apps/core/src/outbox/README.md (relay + `outbox:replay`), docs/domain.md (legal_entity, ledger_entry), docs/adr/0003-outbox-events.md item 6, packages/db/migrations/0008_ledger.sql + 0009 (ledger_entry is store-kind RLS)
Never touches:
- core internals, packages/* (CONTRACT CHANGE issues instead), other apps

## Mission — Phase 4 (Events, accounting, CRM)
Double-entry ledger from events (order.placed, order.cancelled, payment.captured, refund.issued, shipment.shipped — each carries legal_entity_id; payment.captured carries fee_minor): chart of accounts per legal entity, balanced journal entries, PSP fee matching and payout reconciliation, Odoo sync, Finance-only read API. Gate (Integration 4): a month replayed balances per legal entity and matches PSP payouts to the cent.

## Done
- (nothing yet)

## In progress
- (nothing yet)

## Next — Phase 4 (issues, in order)
- [ ] #548 15.1 Ledger consumer + posting rules (group `accounting.ledger`; tables via `CONTRACT CHANGE: accounting ledger tables`)
- [ ] #549 15.2 PSP fee matching + payout reconciliation (fixture Stripe reports; live waived)
- [ ] #550 15.3 Odoo sync adapter (JSON-RPC + mock; live waits for the owner's instance)
- [ ] #551 15.4 Finance-only read API (`packages/contracts/openapi/accounting.yaml` via CONTRACT CHANGE; `finance` on organization)
- [ ] #552 15.5 Month replay gate (CI line via REQUEST; three consecutive green CI runs before merge)

## Decisions made (with reasons)
- 2026-10-23 (manager, kickoff — full text on #548–#552): tables in packages/db, manager-landed (integration landing: manager's db commit on `integration/<name>`, you cut your commit from that sha); shared `consumer_processed` (db 0202) landed by the manager before your first PR, markProcessed in the ledger's own transaction; revenue recognised at shipment (order.placed → contract liability), the accountant validates the chart before launch; COGS and chargebacks out of the gate (no cost field, no dispute event) — file the CONTRACT CHANGEs that would add them; per-currency balance, no FX conversion this phase; Stripe and Odoo live use waived to the launch checklist until keys / an instance exist.

## Blocked / waiting
- Odoo instance: asked of the owner 2026-10-23 (mock until then).
- Stripe test keys (#361): fixture payout reports until then.

## Gotchas learned
- (from Memory-main, read its Global gotchas) loopback 127.0.0.1 for DB and broker; rebuild workspace packages after every merge of main (stale dist); order tests need more than ten rows (text-sort bug class, #543).

## How to run & test this package
- (fill in after first setup: exact commands)
