# Memory 15 — Automatic accounting
Window: 15 · Key: `accounting` · Branch prefix: `accounting/` · Model: Fable (strongest; money)
Last updated: 2026-10-23 (window 15, session one) · Contracts: contracts-v0.4.26, events-v1 = 2abe310 · Last commit: see git log (accounting/phase4) · Status: #548 built incl. the parking change, all gates green, main (653d817, 0202) merged; waiting for the manager's 0203 integration sha to cut from, then PR — worktree ../wt-accounting, branch accounting/phase4 from 1c5a941

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
- 2026-10-23 **#548 15.1 ledger consumer + posting rules — code complete on accounting/phase4** (commits 4591996 + the parking commit; PR not yet opened). Manager change applied: an event before its order is PARKED (`accounting_parked_event`, mark in the same tx) and applied by order.placed in occurred_at order; DLQ for defects only; retries 5. Tests 40/40 incl. shuffled-topic month (317 events, 127 parked = 127 applied, identical ledger). apps/accounting 0.2.0: `createLedgerConsumer` (group `accounting.ledger`, five topics, retries 10, SDK processed store on `consumer_processed`), `handleLedgerEvent` (one transaction: projection → pure posting → ledger rows → projections → `ctx.markProcessed(tx)`), pure posting per topic, default chart (12 accounts), projections, `/health`, scripts dev/start/once. Tests 37/37 (pure 25, SQL 8, live broker 4); root lint + typecheck green; ownership OK; prettier clean. Issues filed: #558 CONTRACT CHANGE ledger tables (0203 SQL), #559 CONTRACT CHANGE COGS unit cost (out of gate), #560 CONTRACT CHANGE payment.disputed (out of gate), #561 REQUEST topics.policy consumer_groups.

## In progress
- **#548 15.1 ledger consumer + posting rules.** Plan sent to the manager 2026-10-23; CONTRACT CHANGE #558 filed (0203 SQL, one landing for #548 + #549; flagged that 0202 `consumer_processed.organization_id` needs `DEFAULT app.current_organization_id()` because the SDK inserts group_id + outbox_id only).
  - Layout: `src/main.ts` (process, /health :9003), `src/consumer.ts` (`createLedgerConsumer`, group `accounting.ledger`, retries 10), `src/posting/<topic>.ts` (pure), `src/posting/balance.ts`, `src/chart.ts`, `src/projection.ts`, `src/ledger.ts`; `migrations/0202_consumer_processed.local.sql` + `0203_accounting_ledger.sql` applied by tests until landed.
  - Chart: 1000 Bank, 1100 PSP clearing, 1200 AR, 2100 Carrier payable, 2200 VAT payable, 2300 CL goods, 2310 CL shipping, 4000 Rev goods, 4010 Rev shipping, 4090 Refunds (contra), 6000 Shipping cost, 6100 PSP fees.
  - Postings: placed Dr1200 total / Cr2300 Σ line net / Cr2310 shipping net (= total − tax − Σ line net) / Cr2200 tax; shipped per item Dr2300/Cr4000 floor-cumulative release + first shipment Dr2310/Cr4010 + cost Dr6000/Cr2100; captured Dr1100 amount−fee, Dr6100 fee / Cr1200; refund cancellation Dr1200/Cr1100, other reasons Dr4090 net + Dr2200 proportional tax / Cr1100; cancelled reverses the unreleased remainder.
  - Steps: [x] package + chart + posting + unit tests [x] projection + ledger SQL + DB tests [x] consumer + live broker test [x] main/health [x] README/CHANGELOG/CLAUDE.md [x] #559/#560/#561 filed [x] gates → [ ] manager go-ahead → merge main → push → PR (number + head sha to the manager) → checks finished → report.
  - Landing (manager, 2026-10-23): integration landing — manager reviews #558 (rev 2 incl. parked table) and commits 0203 on `integration/accounting-ledger` from main, sends the sha; I cut my commit(s) from THAT sha, drop migrations/0203 copy, push accounting/phase4, open the PR (manager fast-forwards onto the integration branch; one PR closes #548 + #558). 0202 is on main (#557 = 012fefe) — local stand-in deleted. psp_payout stays in #558. Lockfile: a clean `pnpm install` from main's lockfile still re-resolves the medusa peer hash (picomatch@4.0.7 on fdir / admin-vite-plugin) — say so in the PR body.

## Next — Phase 4 (issues, in order)
- [ ] #548 15.1 Ledger consumer + posting rules (group `accounting.ledger`; tables via `CONTRACT CHANGE: accounting ledger tables`)
- [ ] #549 15.2 PSP fee matching + payout reconciliation (fixture Stripe reports; live waived)
- [ ] #550 15.3 Odoo sync adapter (JSON-RPC + mock; live waits for the owner's instance)
- [ ] #551 15.4 Finance-only read API (`packages/contracts/openapi/accounting.yaml` via CONTRACT CHANGE; `finance` on organization)
- [ ] #552 15.5 Month replay gate (CI line via REQUEST; three consecutive green CI runs before merge)

## Decisions made (with reasons)
- 2026-10-23 (window 15, #548): **line net = total_minor − tax_minor; shipping net = total − tax − Σ line net** (the remainder) so every placed entry balances by construction in both price modes and rounding drift lands in 2310, never in an imbalance. **Release per line = floor(net × cumulative shipped / qty) − released so far**, remainder on the last units. **Shipping released with the first shipment.** **Refund tax part = round-half-up(amount × order tax / order total)**; reason `cancellation` posts Dr 1200 / Cr 1100 (the cancel already reversed the sale). **Cancel reverses the unreleased remainder** from the projection, ignoring the event's totals. **Missing projection = PARK** (manager 2026-10-23: a fresh-group replay reads all topics at once, a hand-emptied DLQ would break #552's second-replay-no-op): `accounting_parked_event` + mark in one tx; order.placed applies the order's parked events in envelope occurred_at order and deletes them; a parked event that fails on apply fails the order.placed (→ DLQ with that class). DLQ for defects only; #552 needs no topic order. **Lines are netted per account per event** so UNIQUE (source_event_id, account_code) never fires on a legitimate entry. **Payout postings (#549) will use psp_payout.id as source_event_id with source_topic `psp.payout`** (no outbox event exists for a payout).
- 2026-10-23 (manager, kickoff — full text on #548–#552): tables in packages/db, manager-landed (integration landing: manager's db commit on `integration/<name>`, you cut your commit from that sha); shared `consumer_processed` (db 0202) landed by the manager before your first PR, markProcessed in the ledger's own transaction; revenue recognised at shipment (order.placed → contract liability), the accountant validates the chart before launch; COGS and chargebacks out of the gate (no cost field, no dispute event) — file the CONTRACT CHANGEs that would add them; per-currency balance, no FX conversion this phase; Stripe and Odoo live use waived to the launch checklist until keys / an instance exist.

## Blocked / waiting
- #558 `CONTRACT CHANGE: accounting ledger tables` (0203, rev 2 with accounting_parked_event) — manager-landed on integration/accounting-ledger; waiting for the sha. Local copy apps/accounting/migrations/0203_accounting_ledger.sql until then.
- Odoo instance: asked of the owner 2026-10-23 (mock until then).
- Stripe test keys (#361): fixture payout reports until then.

## Gotchas learned
- `createPgProcessedStore` inserts (group_id, outbox_id) only → 0202 has `organization_id DEFAULT app.current_organization_id()`, RLS `organization_only` (a store session sees none), UPDATE revoked, DELETE kept, `group_id ~ '^[a-z][a-z0-9_.-]*
- Tests on the shared broker: pass `groupId: `${prefix}accounting.ledger`` + `topicPrefix` so a test never joins the real group; the SDK does NOT prefix the group id itself.
- Prettier is not part of `pnpm lint`: run `npx prettier --write apps/accounting` before committing (CI has `format:check`).
- No python on this machine: scripted edits with node (`node script.mjs`), see the scratchpad pattern.
- `pg` returns bigint as strings; `Number()` every amount read from SQL.
- (from Memory-main, read its Global gotchas) loopback 127.0.0.1 for DB and broker; rebuild workspace packages after every merge of main (stale dist); order tests need more than ten rows (text-sort bug class, #543).

## How to run & test this package
- Setup once per worktree: `pnpm install --frozen-lockfile`, `pnpm turbo run build --filter=@platform/auth-sdk --filter=@platform/db --filter=@platform/events --filter=@platform/contracts`, `pnpm --filter @platform/auth-sdk fga:seed` (done 2026-10-23).
- Package: `pnpm --filter @platform/accounting test|typecheck|lint`; DB tests need the stack (Postgres 127.0.0.1:5433), broker tests need Redpanda 127.0.0.1:19092 (skip with a printed reason otherwise).
` (test group ids must match).
- Fixture envelopes: `makeEvent` stamps occurred_at = now; pass `occurredAt: new Date(<fact ts>)` or parked events apply in construction order, not fact order (bit me once).
- `s.match(re)` without /g returns the capture groups, not the match count — count with /g in scripted edits.
- Tests on the shared broker: pass `groupId: `${prefix}accounting.ledger`` + `topicPrefix` so a test never joins the real group; the SDK does NOT prefix the group id itself.
- Prettier is not part of `pnpm lint`: run `npx prettier --write apps/accounting` before committing (CI has `format:check`).
- No python on this machine: scripted edits with node (`node script.mjs`), see the scratchpad pattern.
- `pg` returns bigint as strings; `Number()` every amount read from SQL.
- (from Memory-main, read its Global gotchas) loopback 127.0.0.1 for DB and broker; rebuild workspace packages after every merge of main (stale dist); order tests need more than ten rows (text-sort bug class, #543).

## How to run & test this package
- Setup once per worktree: `pnpm install --frozen-lockfile`, `pnpm turbo run build --filter=@platform/auth-sdk --filter=@platform/db --filter=@platform/events --filter=@platform/contracts`, `pnpm --filter @platform/auth-sdk fga:seed` (done 2026-10-23).
- Package: `pnpm --filter @platform/accounting test|typecheck|lint`; DB tests need the stack (Postgres 127.0.0.1:5433), broker tests need Redpanda 127.0.0.1:19092 (skip with a printed reason otherwise).
