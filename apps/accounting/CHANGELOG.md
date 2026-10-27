# Changelog — @platform/accounting

## 0.6.6 — 2026-10-27 (#627)

- Fix: in a process whose time zone is not UTC, every `date` was served (and sent to Odoo) one day EARLY east of
  UTC. node-postgres parses `date` as local midnight; `toISOString()` shifted it. Every date column is now selected
  `::text` (Finance API: `entry_date`, `first_entry_date` / `last_entry_date`, `oldest_unposted_entry_date`,
  `arrival_date`, `available_on`; ERP sync: the move `date`), and the API formatter throws on a Date. Timestamps are
  unchanged (instants). Dockerfile: `ENV TZ=UTC` (defence in depth).
- Tests: 101 (+3, `test/timezones.test.ts`: UTC, Asia/Tokyo, America/Los_Angeles).

## 0.6.5 — 2026-10-25 (Integration 4, Refs #594)

- The month replay gate (`test/month-replay.test.ts`) spawns the REAL apps/core CLIs: `relay-cli --once
--topic-prefix <p> --throwaway-db --no-registry` against its throwaway database, and `replay-cli --topic <t>
--topic-prefix <p>` once per topic (orders last). The reproduction through `@platform/events`' wire functions
  (`outboxRowToEnvelope` + `envelopeToMessage`, the deviation accepted on #552) is removed. Every event topic of
  the repo's policy is created under the run's prefix (the relay's start-up check). The relay and replay ceilings are
  60 s each (they include process start-up; unmeasured locally, first measured by the required CI runs).

## 0.6.4 — 2026-10-25 (Integration 4, Refs #594)

- The consumer group is configurable: `ACCOUNTING_GROUP_ID`, or `--group <id>` / `--group=<id>` (the flag wins);
  default `accounting.ledger`; validated like `consumer_processed.group_id`. `/health` and the start line report the
  group in use. Integration 4 runs `once` with a fresh `accounting.ledger.int4` from the beginning of the dev topics.
- Tests: 98 (+3, `src/config.test.ts`).

## 0.6.3 — 2026-10-25 (#575 review fixes, Opus review of #591)

- A move cancelled in Odoo is handled: `ErpMove.state` includes `cancel`; `postMove` refuses it
  (`OdooMoveCancelled`) instead of calling `action_post`; the sync reports it like a refusal and never marks its rows
  (the rest continue); `findMoveByRef` prefers a posted move, then a draft, then a cancelled one when several share
  the ref. Mock seam `cancelMove`.
- `odoo:init` is local only: a non-loopback `ODOO_URL` is refused before any call (`OdooInitRemoteRefused`) unless
  `--allow-remote` is passed (`isLocalOdooUrl`); it no longer writes `currency_id` on a company it finds — a
  same-named company in another currency skips that legal entity (`companies_skipped`). The mock answers what
  `odoo:init` calls (db list, module, currencies, company / account / journal create, writes recorded).
- Nits: createMove's "nothing committed, rethrow" path tested (mock seam `failNextCreate`); the `dateOf` comment back
  on `dateOf`; `package.json` version follows this CHANGELOG (was 0.2.0 since #548).
- Tests: 95 (+4).

## 0.6.2 — 2026-10-24 (#589, 15.5a)

- Event times are compared as instants, never as strings (Opus review of #588): `instantOf` in `posting/balance.ts`;
  the late-shipment rule (`shipment-shipped.ts`: before or after the cancellation) and the reconciliation window
  (`matcher.ts`: window end and start) use it. The contract only promises `format: date-time`: `09:00:00.500Z` sorted
  before `09:00:00Z` and offsets broke the order, so a shipment after the cancel could be booked as revenue. The
  parked-event apply order and the window-start query already order in SQL on `timestamptz`; `dateOf` already parsed.
- Nit: a zero-base order (every net 0, tax > 0) cancelled — `cancellationVat` takes the shipped state explicitly and
  the late shipment passes the after-state, so the VAT no longer depends on arrival order.
- Nit: `test/month-replay.test.ts` afterAll drops the two throwaway databases in a `finally` (a broker failure in
  `deleteTopics` no longer leaves them behind).
- Tests: 91 (+5): fractional seconds, a +02:00 offset, equal instants written differently (posting and matcher), the
  zero-base cancel in both arrival orders.

## 0.6.1 — 2026-10-24 (#575, 15.3a)

- Odoo crash cases before live use: a DRAFT left by a crash between `create` and `action_post` is posted before its
  rows are marked (`moves_posted_drafts`, `postMove` on the adapter); a create whose answer is lost after Odoo committed
  it is no longer retried blindly — writes are sent once, the client searches by `ref` and uses what it finds (mock
  seam `commitThenFailNextCreate`). Nits: `faultClass` matches Odoo's exception names, not `/access/i`; the live probe
  prints no URL; CLAUDE.md typo.
- `pnpm odoo:init`: database, `account` module, companies per seeded legal entity, our accounts and journals, the
  mapping — idempotent — for the dev-stack Odoo Community 17 (compose profile `erp`).
- Legal entities whose code starts with `e2e-` (the admin e2e journeys leave one per run in the shared dev database)
  never reach Odoo: `odoo:init` skips them (`skip_e2e_legal_entities`), the mapping step and `syncLegalEntity` refuse
  them (`LegalEntityExcluded`); `isSyncableLegalEntity` / `assertSyncable` exported (manager decision 2026-10-24).
- Tests: 86 (+3).

## 0.6.0 — 2026-10-23 (#552, 15.5)

- The Integration 4 accounting gate (`test/month-replay.test.ts`): a 3-entity / 3-currency generated month through the
  outbox table, relayed onto prefixed topics and consumed live, then replayed — all topics at once, orders last — into a
  fresh group and database: zero trial balance per legal entity per currency with every currency present, per-account
  totals identical to the live ledger, payout reports reconciled with zero differences, a second replay a no-op.
  Three consecutive local runs green; ceilings ≥ 5× the medians. CI line by REQUEST #578; `--topic-prefix` on the
  core CLIs by REQUEST #579 (until then the test reproduces relay/replay through @platform/events).
- Posting: a shipment dated BEFORE the order's cancellation but consumed after it (separate partitions) recognises the
  shipped part against the receivable and gives back the over-reversed VAT — the same ledger as fact order; the
  cancellation no longer marks everything released (the projection keeps the actual amounts). A shipment dated at or
  after the cancellation stays a defect.
- Generator: a third legal entity (C/USD) through `legalEntities: 3`; `payoutReportFor` exported for the gate.
- Tests: 83 (+10: the gate, and the auth edge cases from the Fable review of #582 — dev tokens refused in production,
  the 503 fail-closed path).

## 0.5.0 — 2026-10-23 (#551, 15.4)

- Finance read API (`src/api`) under `/accounting/v1`, mounted next to `/health`: routes, query parameters and
  `x-permission`s read from the landed contract (`packages/contracts/openapi/accounting.yaml`, CONTRACT CHANGE #572,
  contracts 0.4.28, resolved through `@platform/contracts`); staff JWT through @platform/auth-sdk + `finance` on
  `organization:hq` via OpenFGA (dev tokens with `ACCOUNTING_DEV_TOKENS=1`); seven reads: books, trial balance,
  journal lines, parked events, payouts, payout detail, ERP status. Dependencies: `@platform/auth-sdk`, `yaml`;
  dev `ajv`, `ajv-formats` (response validation in tests).
- Contract revision 2 (Fable review of #572): shared `BadRequest` (400 `validation_error`) on every operation with
  validatable query parameters, `Limit` aligned with the house (default 20, max 100), `getPayout`'s lines paginated
  (`PayoutLinePage`), `minimum: 0` on debit / credit, reference fields documented as always set, the empty-period
  shape documented, `legal_entity_id` = the admin API's `LegalEntity.id`, mock port 4013. The server follows (limit
  bounds, paginated payout lines).
- Tests: 73 (+9: the contract as loaded + route matcher; the API over HTTP with 401 / 403 / 200 per role).

## 0.4.0 — 2026-10-23 (#550, 15.3)

- ERP sync (`src/erp`): `ErpAdapter` with the Odoo JSON-RPC client (`/jsonrpc`, `execute_kw` on `account.move` /
  `account.account` / `account.journal` / `res.company`; timeouts, bounded transport retries, faults as named
  `ErpError`s) and an in-memory mock server enforcing Odoo's rules (balanced move, company-consistent accounts and
  journal, archived accounts); the mapping steps `mapLegalEntityToCompany` (`legal_entity.odoo_company_id`) and
  `mapChart` (`ledger_account.erp_account_id`, optional code map); `syncLegalEntity` — one move per (event, journal),
  `ref` = `<source_event_id>/<journal>`, search before create, refused moves reported and the rest continue, skips with
  a reason (unmapped account, missing journal, foreign currency); CLI `pnpm erp:sync`.
- Tests: 64 (+9: client vs mock, sync on the clean-month ledger incl. re-run, refusal, crash recovery, code map).
  Live Odoo block skipped until the owner's instance exists (ODOO_URL).

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
