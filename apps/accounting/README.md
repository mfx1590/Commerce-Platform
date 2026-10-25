# @platform/accounting

The ledger service (Phase 4, window 15). One bus consumer, group `accounting.ledger`, turns the five ledger events
(`order.placed`, `order.cancelled`, `payment.captured`, `refund.issued`, `shipment.shipped` — ADR 0003 item 6) into
balanced double-entry journal entries per legal entity in `ledger_entry`. It derives everything from events and its
own projections; it never reads a core table and no UI action writes the ledger. See [CLAUDE.md](./CLAUDE.md) for the
run / test commands and the public API; the posting rules and the worked examples are below.

## Layout

```
src/main.ts               process: app-role pool, organization client, the consumer, GET /health (PORT, default 9003)
src/consumer.ts           createLedgerConsumer (events-v1 consumer SDK) + handleLedgerEvent (one event, one transaction)
src/posting/<topic>.ts    one PURE posting function per topic: envelope (+ order projection) → entries + projection changes
src/posting/balance.ts    integer arithmetic, aggregation per account, the balance check
src/chart.ts              the default chart of accounts (codes the rules reference; one copy per legal entity in ledger_account)
src/projection.ts         accounting_order / _line / _payment / _refund on a scoped transaction
src/ledger.ts             ledger_entry writes, chart seed, trial balance
test/                     throwaway database + local broker tests; src/posting/*.test.ts are pure
```

## How one event becomes ledger rows

`handleLedgerEvent(client, message, { markProcessed })` runs ONE transaction on the organization-scoped client:

1. validate the envelope and its payload against the published schema (`InvalidEvent` → DLQ);
2. refuse an event of another organization (`ForeignOrganization`);
3. take a transaction-scoped advisory lock on the order (`pg_advisory_xact_lock(hashtext(order_id))`: two
   instances of the group never interleave one order's events, parked or not), then lock and load the order
   projection (`accounting_order` + lines, `FOR UPDATE`);
4. the pure posting function returns the entries (aggregated per account, balanced per currency — or it throws) and the
   new projection state;
5. seed the chart for the legal entity if needed (`ledger_account`, `ON CONFLICT DO NOTHING`), insert the
   `ledger_entry` rows, write the projections;
6. `ctx.markProcessed(tx)`: the `consumer_processed` row commits WITH the rows — once per group.

`UNIQUE (source_event_id, account_code)` on `ledger_entry` is the second guard: the lines of an event are netted per
account before the insert, so it never fires on a legitimate entry, and a bypass of the processed store rolls the
whole transaction back (tested). A redelivered `order.placed` (same event id as the projection's source) posts nothing
even without the mark; a different second placement of the same order is a producer defect (`DuplicateOrderPlaced`).

**Tables (packages/db 0203, landed as db 0.3.17 from CONTRACT CHANGE #558; docs/domain.md points here).**

| Table                                       | Purpose                                                                                                          |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `ledger_entry` (0008 + 0203)                | the journal lines: one row per (event, account), balanced per event per currency                                 |
| `ledger_account`                            | the chart of accounts per legal entity (code, name, type, Odoo account once mapped)                              |
| `accounting_order`, `accounting_order_line` | the ledger's own projection of an order from `order.placed`: nets, released amounts, VAT, shipping, status       |
| `accounting_parked_event`                   | a shipment / refund / cancel that arrived before its order, with its envelope; deleted when the order applies it |
| `accounting_payment`, `accounting_refund`   | projections of captures and refunds with the PSP ids (#549 matches payout rows against them)                     |
| `psp_payout`, `psp_payout_line`             | imported payout reports and their balance transactions with the match verdict (#549)                             |
| `consumer_processed` (0202, shared)         | the consumer SDK's processed store: one row per (group, outbox id), marked in the posting transaction            |

**Rules the schema enforces.** Every accounting table — `ledger_entry` included — is
RLS `organization_only`: a store-scoped session reads and writes none (accounting is an HQ function; `finance` on the
organization). A ledger line a store's fact caused carries that `store_id`; a legal-entity-level line (a payout, a bank
movement) carries `store_id` NULL. Immutability is in SQL: the application role can never DELETE a ledger line, an
account, a payout line or a payment / refund projection, and can UPDATE a ledger line only in `posted_to_erp_at` and
`erp_reference` (the ERP sync). Known limit: whether a payload's `legal_entity_id` belongs to its `organization_id` is
the consumer's to check — RLS fences the session's organization, it does not validate the pairing (the events come
from the core's own outbox, which writes both from the same store row).

**Cross-topic order (parking).** The five topics are separate partitions, so a `shipment.shipped`, a `refund.issued` (reasons
other than `cancellation`) or an `order.cancelled` routinely reaches the consumer before its `order.placed` — a replay
into a fresh group reads all five topics at once. Such an event is PARKED: its envelope goes to `accounting_parked_event`
and its processed mark commits in the same transaction (nothing posted). When the `order.placed` arrives, its handler
applies the order's parked events in `occurred_at` order inside its own transaction and deletes them. A redelivery of a
parked event is a duplicate like any other. The DLQ is for real failures only (a shipment beyond the ordered quantity,
an unknown line, an invalid payload …): the SDK retries 5 times, then `dlq.accounting.ledger` records the class and
the partition continues. A parked event that fails when the order applies it fails the order's transaction, which then
dead-letters with that class. The month replay gate (#552) therefore needs no topic order.

Logs are JSON lines with ids, counts, amounts and error classes only — never a payload field (tested over every line
the live test produces).

## Chart of accounts (default, per legal entity)

| Code | Account                                 | Type      | Posted by                                       |
| ---- | --------------------------------------- | --------- | ----------------------------------------------- |
| 1000 | Bank                                    | asset     | payout postings (#549)                          |
| 1100 | PSP clearing (captured, not paid out)   | asset     | payment.captured, refund.issued, payouts (#549) |
| 1200 | Accounts receivable — trade             | asset     | order.placed, payment.captured, order.cancelled |
| 2100 | Carrier payable                         | liability | shipment.shipped (cost)                         |
| 2200 | VAT payable                             | liability | order.placed, refund.issued, order.cancelled    |
| 2300 | Contract liability — goods              | liability | order.placed, shipment.shipped, order.cancelled |
| 2310 | Contract liability — shipping           | liability | order.placed, shipment.shipped, order.cancelled |
| 4000 | Revenue — goods                         | revenue   | shipment.shipped                                |
| 4010 | Revenue — shipping                      | revenue   | shipment.shipped (first shipment of the order)  |
| 4090 | Refunds and allowances (contra revenue) | revenue   | refund.issued (return, goodwill, chargeback)    |
| 6000 | Shipping cost                           | expense   | shipment.shipped                                |
| 6100 | PSP fees                                | expense   | payment.captured                                |

Recognition (manager decision 2026-10-23, Phase 4 default; the owner's accountant validates the chart before launch):
**revenue at shipment** — a placed order is a liability to deliver, released line by line as parcels leave.

Definitions used everywhere: **line net** = `line.total_minor − line.tax_minor` (net of VAT in both price modes:
exclusive `total = sub − disc + tax`, inclusive `total = sub − disc` with the tax inside); **shipping net** =
`totals.total_minor − totals.tax_minor − Σ line net` (the remainder, so a rounding difference between the lines and the
totals can only land there, never unbalance an entry). Entries balance **per currency**; the legal entity's reporting
currency is not converted in this phase (decision 6).

## Posting rules with one worked example each

The example order (store brand-a, legal entity le-brand-a, EUR): 2 × 49.99 at 21 % VAT, 1 × 10.00 with 2.00 off at
21 %, shipping 4.95 + 1.04 VAT. Totals: subtotal 109.98, discount 2.00, shipping 4.95, tax 21.00 + 1.68 + 1.04 =
23.72, total **136.65**. Line nets: 99.98 and 8.00 → goods net 107.98; shipping net 4.95.

### order.placed → journal `sales`, reference the order

| Account | Debit  | Credit |
| ------- | ------ | ------ |
| 1200    | 136.65 |        |
| 2300    |        | 107.98 |
| 2310    |        | 4.95   |
| 2200    |        | 23.72  |

Projection written: `accounting_order` (total, tax, goods net, shipping net, released 0) and one
`accounting_order_line` per line (quantity, net, shipped 0, released 0).

### payment.captured → journal `psp_fees`, reference the payment

Amount 136.65, fee 4.21 (`fee_minor` null = 0; #549 matches the real fee from the payout report).

| Account | Debit  | Credit |
| ------- | ------ | ------ |
| 1100    | 132.44 |        |
| 6100    | 4.21   |        |
| 1200    |        | 136.65 |

### shipment.shipped → journals `sales` (release) and `shipping` (cost), reference the shipment

Release of a line = `floor(net × shipped_total / quantity) − released so far` (the remainder of the division lands on
the last units; 3 units of net 99.99 release 33.33 / 33.33 / 33.33, 10 units of net 9.99 shipped 3 + 7 release 2.99 +
7.00). Shipping net is released with the FIRST shipment of the order. The cost posts in the shipment's own currency.
Full shipment of the example, carrier cost 4.50:

| Journal  | Account | Debit  | Credit |
| -------- | ------- | ------ | ------ |
| sales    | 2300    | 107.98 |        |
| sales    | 4000    |        | 107.98 |
| sales    | 2310    | 4.95   |        |
| sales    | 4010    |        | 4.95   |
| shipping | 6000    | 4.50   |        |
| shipping | 2100    |        | 4.50   |

Defects that dead-letter at once: a line shipped beyond its quantity (`ShipmentExceedsOrder`), an unknown line
(`UnknownOrderLine`), a shipment of a cancelled order (`ShipmentOfCancelledOrder`).

### refund.issued → journal `refunds`, reference the refund

Reason `return` / `goodwill` / `chargeback`: revenue and VAT reversed in the order's proportion, tax part =
`round-half-up(amount × order tax / order total)` from the projection. Full return of the example (136.65; tax part
23.72):

| Account | Debit  | Credit |
| ------- | ------ | ------ |
| 4090    | 112.93 |        |
| 2200    | 23.72  |        |
| 1100    |        | 136.65 |

A 10.00 goodwill refund: tax part 10.00 × 23.72 / 136.65 = 1.74 → 4090 8.26, 2200 1.74, 1100 10.00.

Reason `cancellation`: the sale was already reversed by `order.cancelled`, the refund settles the customer's credit:
**Dr 1200 / Cr 1100** for the amount (no projection needed). The PSP keeps its fee on a refund, so 6100 stays. A
chargeback posts like a return until a dispute event exists (CONTRACT CHANGE filed; out of the Phase 4 gate).

### order.cancelled → journal `sales`, reference the order

Reverses what is still UNRELEASED (an unshipped order: the placed entry exactly; a partially shipped order keeps the
revenue of what left): Dr 2300 `goods net − released`, Dr 2310 `shipping net` unless released, Dr 2200
`round-half-up(tax × unreleased / (goods net + shipping net))`, Cr 1200 the sum. Amounts come from the projection, the
event's `totals` are not used. Unshipped example:

| Account | Debit  | Credit |
| ------- | ------ | ------ |
| 2300    | 107.98 |        |
| 2310    | 4.95   |        |
| 2200    | 23.72  |        |
| 1200    |        | 136.65 |

Partially shipped (2 × 50.00 at 20 %, shipping 10.00 + 2.00, one unit shipped): Dr 2300 50.00, Dr 2200 10.00
(= 22.00 × 50 / 110), Cr 1200 60.00. A second cancel posts nothing. A zero-base order (every net 0, tax > 0) has no
proportion: its cancel reverses the whole tax when nothing has shipped and none once anything has, in either arrival
order.

### A whole life, netted

Placed → captured (fee 4.21) → shipped (cost 4.50) → returned in full leaves: 1100 −4.21 (the fee the PSP kept),
6100 +4.21, 4000 −107.98, 4010 −4.95, 4090 +112.93, 6000 +4.50, 2100 −4.50 — and 1200, 2200, 2300, 2310 at zero.

## Reconciliation (#549)

`src/reconcile/`: a payout report is imported, matched against the ledger's own projections and, when it matches to
the cent, posted; every difference is reported as a JSON line (ids and amounts only). One transaction per payout.

- **Source** — `PayoutSource { listPayouts(legalEntityId), payout(legalEntityId, payoutId) }`. The fixture source
  (`createFixtureSource`, `loadFixtureDir`) reads `fixtures/payouts/<set>/payouts*.json`: one report per legal entity
  in the normalised shape of Stripe's itemized payout reconciliation report / `GET /v1/balance_transactions?payout=`
  (`balance_transaction_id`, `reporting_category`, `gross_minor` / `fee_minor` / `net_minor` as integers,
  `available_on`, `created`, `source_id`, `payment_intent_id`, `charge_id`, `refund_id`). No Stripe keys exist
  (#361): the live source is WAIVED to the launch checklist and plugs into the same interface.
- **Matching** (`matchPayout`, pure) — a charge row ↔ `accounting_payment` by `payment_intent_id` (what
  `payment.captured` carries as `provider_payment_id`) or `charge_id`: gross must equal `amount_minor`, fee must equal
  `fee_minor`; a refund row ↔ `accounting_refund` by `refund_id`: −gross must equal `amount_minor`; Σ net of the rows
  must equal the payout amount. Only the payments of the report's provider count (one PSP account per legal entity
  and provider).
- **Discrepancies** — `unmatched_charge` (a row the ledger never saw: an unknown charge or refund, a fee or
  adjustment row), `unmatched_ledger_line` (a capture or refund that fell in this payout's window — from the latest
  ledger time an earlier payout of the same provider matched to the latest this one matched, per type — but no row
  carries), `fee_difference`, `amount_difference` (a row's gross, or the payout total vs Σ net). Each line:
  `{ reconcile: 'psp.payout', legal_entity_id, payout_id, kind, currency, balance_transaction_id?, provider_reference?,
reference_type?, reference_id?, expected_minor?, actual_minor?, difference_minor }`.
- **Posting** — only a payout with zero discrepancies posts, journal `bank`, `source_event_id` = `psp_payout.id`,
  `source_topic` `psp.payout` (a local marker, not a bus topic), reference the payout, `store_id` NULL (a payout is a
  legal-entity-level fact and spans stores):

  | Account | Debit  | Credit |
  | ------- | ------ | ------ |
  | 1000    | amount |        |
  | 1100    |        | amount |

  After a clean reconciliation the PSP clearing account (1100) of the legal entity nets to exactly what the PSP
  still holds: captures net of fees minus refunds not yet paid out (tested on the clean month).

- **Order of imports** — `reconcileAll` imports a legal entity's payouts oldest first (by arrival date, then payout id)
  whatever order the source lists them, and the window start of a payout only ever comes from payouts EARLIER by
  that same order (a re-import of an older payout sees the window it saw the first time; later payouts never widen
  it). Importing single payouts by hand out of order reports false `unmatched_ledger_line` findings for the gap —
  import oldest first.
- **Known limits** — fee / adjustment / other rows (a Stripe fee row, a dispute adjustment) have no ledger
  counterpart yet and are reported as `unmatched_charge` for now (#560 adds disputes); re-importing a payout whose
  report now has FEWER rows than before keeps the earlier rows in `psp_payout_line` (lines are upserted, never
  deleted) — the stale lines stay with their old verdict until the report is corrected and the payout re-matched.
- **Idempotency** — `psp_payout` is UNIQUE per (legal entity, provider, payout id): a reconciled payout imported
  again is a no-op (`already_reconciled`), a discrepant one is re-matched (the ledger may have caught up) and posts
  once it is clean; `psp_payout_line` is UNIQUE per (payout, balance transaction).
- **Fixtures** — `pnpm fixtures:payouts` builds `fixtures/payouts/{clean-month,discrepant-month}/{events,payouts}.json`
  from a deterministic 60-order month (seeded ids): the clean month's four weekly payouts per legal entity match to
  the cent and leave the last days unpaid; the discrepant month carries exactly one difference kind on each of legal
  entity A's four payouts. A test fails if a committed file drifts from the builder.
- **CLI** — `pnpm --filter @platform/accounting reconcile -- --fixtures <dir> --legal-entity <uuid> [--payout <id>]`
  (after `build`): exit 0 when every payout reconciled, 2 when any is discrepant.

## ERP sync (#550)

`src/erp/`: the ledger's journal entries become Odoo `account.move`s per legal entity (company =
`legal_entity.odoo_company_id`), idempotently; the rows get `posted_to_erp_at` / `erp_reference` (the Odoo move id).

- **Adapter** — `ErpAdapter { listCompanies, listAccounts, listJournals, findMoveByRef, createMove }`. Two
  implementations: `OdooJsonRpcClient` (`POST /jsonrpc`: `common.authenticate` → uid, then `object.execute_kw` on
  `res.company`, `account.account`, `account.journal`, `account.move` — `search_read`, `create`, `action_post`;
  bounded timeouts, bounded retries on transport failures only, an Odoo fault is never retried and arrives as an
  `ErpError` whose `name` is the class: `OdooUnbalancedMove`, `OdooAccountMissing`, `OdooJournalMissing`,
  `OdooCompanyMismatch`, `OdooAccessDenied`, `OdooValidationError`, `OdooTransport`, `OdooTimeout`) and the in-memory
  `createMockOdoo()` — a JSON-RPC server the real client talks to through its `fetch` seam, enforcing the rules the
  sync relies on (balanced move, accounts and journal of the move's company, archived accounts refused, `action_post`).
- **Mapping steps** (never by hand in SQL): `mapLegalEntityToCompany(client, legalEntityId, companyId)` fills
  `legal_entity.odoo_company_id` (window 15's column, docs/domain.md); `mapChart(deps, legalEntityId)` fills
  `ledger_account.erp_account_id` with the Odoo account of the same code — or of the code the optional
  `accountCodeMap` names when the accountant's chart uses other codes — and lists the codes Odoo lacks.
- **Sync** — `syncLegalEntity(deps, legalEntityId)`: one move per (`source_event_id`, `journal`), `ref` =
  `<source_event_id>/<journal>` (the idempotency key on the Odoo side), journal by code (`sales` → SAL, `psp_fees` →
  PSP, `refunds` → REF, `shipping` → SHP, `bank` → BNK, `cogs` → COGS, `tax` → TAX; `journalCodes` overrides), lines
  = our account code + name, debit / credit in currency units (`toCurrencyUnits`, 2 decimals; 0 for JPY-like
  currencies). Search before create: a crash between create and mark is recovered on the next run (`moves_found`),
  never a second move. A refused move is reported (`erp_refused`: class, source event id, journal) and the rest of
  the batch continues; its rows stay unposted. Skipped with a reason: `account_unmapped` (a code Odoo lacks),
  `journal_missing`, `currency_unsupported` (a move not in the company's currency — no FX this phase).
- **CLI** — `pnpm --filter @platform/accounting erp:sync -- --legal-entity <uuid> [--company <id>] [--mock]` (after
  `build`): `--company` runs the mapping step first; `--mock` uses the in-memory Odoo (development). Credentials
  only from `ODOO_URL`, `ODOO_DB`, `ODOO_USER`, `ODOO_API_KEY` — never in git, never in a log line.
- **Crash cases (#575)** — a crash between `create` and `action_post` leaves a DRAFT with our `ref`: the next run finds
  it, POSTS it, then marks the rows (`moves_posted_drafts`). A create whose answer is lost after Odoo committed it is
  never retried blindly (writes are sent once; only reads retry): the client searches by `ref`, uses the move it finds
  (draft → posted) and only rethrows the transport error when nothing was committed — one move per ref, always. Both
  tested with the mock (`commitThenFailNextCreate`, a draft left on purpose).
- **A move cancelled in Odoo (#591)** — an accountant may cancel one of our moves. It is never re-posted and its rows
  are never marked: the sync reports it like a refusal (`OdooMoveCancelled`), the rest continue, and every run reports
  it again until someone decides. When several moves carry the same `ref` (cancelled, then entered again), a posted
  move wins, then a draft, then the cancelled one; the re-entered move is found and the rows marked against it.
- **`pnpm --filter @platform/accounting odoo:init`** (after `build`) — prepares the dev-stack Odoo Community 17
  (compose profile `erp`, http://127.0.0.1:8069) for the live sync: creates `ODOO_DB` (default `accounting_dev`) with
  the `account` module, one company per seeded legal entity in its currency (currencies activated), our 12 accounts and
  7 journals per company, and the mapping through the sync's own steps (`legal_entity.odoo_company_id`,
  `ledger_account.erp_account_id`). Idempotent: every step searches before it creates. **Local only (#591):** it
  refuses an `ODOO_URL` that is not a loopback host (localhost, 127.0.0.0/8, ::1, `*.localhost`) before any call
  (`OdooInitRemoteRefused`) unless `--allow-remote` is passed, and it never writes to a company it finds: a same-named
  company in another currency skips that legal entity (`companies_skipped`, log step `company_currency_mismatch`). Env: `ODOO_URL`, `ODOO_DB`,
  `ODOO_USER` (`admin`), `ODOO_API_KEY` (the admin password locally), `ODOO_MASTER_PASSWORD` (Odoo's `admin_passwd`,
  `admin` locally) — words in .env.example, never in git. The first run takes minutes (database + module install).
  Legal entities whose code starts with `e2e-` (one per admin e2e run in the shared dev database) are not books: `odoo:init`
  skips them (log step `skip_e2e_legal_entities`), and the mapping step and `syncLegalEntity` refuse them with
  `LegalEntityExcluded` (`isSyncableLegalEntity`, `assertSyncable`).
- **Live Odoo** — a local Odoo Community 17 runs in the dev stack since 2026-10-24 (owner decision); run `odoo:init`
  once, then the live block runs with `ODOO_URL=http://127.0.0.1:8069`. Before that, the instance was the owner's open
  question (asked 2026-10-23). `test/erp.test.ts` has a
  `describe.runIf(odooUp)` block that authenticates and lists companies / accounts when `ODOO_URL` answers, skipped
  with the reason otherwise; the live sync is waived to the launch checklist until then.

## Finance read API (#551)

`src/api/`: the accounting service's own HTTP surface under `/accounting/v1/…`, read-only, served next to `/health`
by `src/main.ts`. The contract is `packages/contracts/openapi/accounting.yaml` (CONTRACT CHANGE #572, contracts 0.4.28),
resolved through the `@platform/contracts` package at start (`ACCOUNTING_SPEC_PATH` overrides it). The server reads the operations, their query parameters and
their `x-permission` from the yaml at construction (`loadApiSpec`), so the permission matrix it enforces is the
contract's.

- **Authentication** — a Keycloak staff-realm JWT through `@platform/auth-sdk` (`createStaffTokenVerifier`), the
  subject must be an active `staff_user`; `Bearer dev:<keycloak_subject>` only with `ACCOUNTING_DEV_TOKENS=1` outside
  production (the core's `CORE_DEV_TOKENS` shape). 401 `unauthorized` otherwise.
- **Authorization** — every operation is `finance` on `organization:hq`, asked of OpenFGA for the `staff_user.id`
  (`can`); a store admin, however many stores, is 403 `forbidden` with `details: { relation, object }`; OpenFGA
  unreachable is 503, fail closed. UI gating is a convenience; this check is the boundary.
- **Operations** — `listLegalEntityBooks`, `getTrialBalance` (per-currency totals whose `difference_minor` is the
  #552 number), `listJournalLines` (paginated; filters `from`, `to`, `currency`, `journal`, `account_code`,
  `reference_type`, `reference_id`, `source_event_id`, `erp=posted|unposted`), `listParkedEvents` (ids and times,
  never the envelope), `listPayouts`, `getPayout` (lines with verdicts), `getErpSyncStatus`. Lists page with `page` / `limit` (default 20, max 100), `getPayout`'s lines too. Unknown or malformed query
  parameters are a 400 `validation_error` naming them (the contract's shared `BadRequest`); a legal entity or payout outside the organization is a 404.
  Money is integer minor with its currency; nothing is summed across currencies. Logs carry operation id, status and
  duration — never a body.

## Month replay gate (#552, the Integration 4 accounting gate)

`test/month-replay.test.ts` proves the two numbers the phase is judged on: a generated month — three legal entities
(EUR, GBP, USD), three stores, orders, captures with fees, partial and full refunds, cancellations, partial and full
shipments — is written to the outbox table (the rows the core's `withEvents` writes), relayed onto the bus in seq order
and consumed live by one `accounting.ledger` group (books balanced), then REPLAYED from the outbox — every topic at
once, orders last — into a FRESH group and a FRESH database:

1. the trial balance is zero per legal entity per currency, each expected currency is present, and the per-account
   totals equal the live ledger's (not the row count: a cancel consumed before an earlier shipment posts a corrective
   entry — more rows, same totals);
2. the month's payout reports, built from the same events, reconcile with zero differences and the PSP clearing account
   equals the open balance;
3. a second replay into the same group changes nothing (duplicates only; entries, processed marks and payouts unchanged).

Counts and balances are the assertions; durations are ceilings only, ≥ 5× the local medians (three runs of the final
code, 150 orders = 556 events: relay 1.0 s, consume 14.8 s, replay 0.2 s, replay-consume 13.2 s, reconcile 0.4 s →
30 / 120 / 30 / 120 / 30 s). `MONTH_REPLAY_ORDERS` scales the month. Skipped with a printed reason when the broker is
down; prefixed topics and group, two throwaway databases, all deleted afterwards. CI runs it in the `live auth +
end-to-end` job and requires its block (REQUEST #578, the #541 pattern); a new required step needs three
consecutive green CI runs on one head before it merges.

**Arrival order is not fact order.** The five topics are separate partitions, so a later `order.cancelled` can be
consumed before an earlier `shipment.shipped` of the same order. The cancel reverses the then-unreleased remainder;
the late shipment (dated before the cancellation) then recognises the shipped part against the receivable and gives back
the VAT the cancel reversed for it — the same ledger as in fact order (tested). A shipment dated at or after the
cancellation stays a defect. "Before" and "after" are compared as INSTANTS (`instantOf`, #589), never as strings: the
events contract only promises `format: date-time`, so `09:00:00.500Z`, `09:00:00Z` and `11:00:00+02:00` do not sort
by time as text. The reconciliation window compares instants the same way.

**Deviation, accepted for now.** The relay and the replay are reproduced through `@platform/events`' wire functions
(`outboxRowToEnvelope` → `envelopeToMessage`, seq order, the replay headers) on prefixed topics: apps/core's
`relay-cli` / `outbox:replay` publish to the real topic names of the shared dev broker, and apps/accounting cannot
import apps/core internals. Once `--topic-prefix` lands on both CLIs (REQUEST #579, window 14) the test
switches to them.

## Out of the Phase 4 gate (manager decision 4)

- **COGS**: no event carries a unit cost (`shipment.shipped` has none, `stock.moved` has none). Journal `cogs` stays
  unused; the CONTRACT CHANGE that would add `unit_cost_minor` to the shipped items is filed.
- **Chargebacks**: no dispute event; a refund with reason `chargeback` posts like a return. The CONTRACT CHANGE for a
  `payment.disputed` topic is filed.
- **FX**: entries balance per currency; no conversion to the legal entity's reporting currency.

## Running it

```bash
pnpm --filter @platform/accounting dev     # tsx watch, the local stack (Postgres 5433, Redpanda 19092)
pnpm --filter @platform/accounting start   # node dist/main.js (the image: `pnpm start`, GET /health on $PORT)
pnpm --filter @platform/accounting once    # consume until the bus has been idle for ACCOUNTING_ONCE_IDLE_MS (5 s), exit
pnpm --filter @platform/accounting once -- --group accounting.ledger.int4   # a fresh group: re-reads every topic from the beginning
```

Environment: `DATABASE_URL_APP` (the app role — never the owner URL), `KAFKA_BROKERS` (default `127.0.0.1:19092`),
`CORE_ORGANIZATION_ID` (default: the seeded HQ), `PORT` / `ACCOUNTING_PORT` (9003), `ACCOUNTING_RETRIES` (5),
`ACCOUNTING_ONCE_IDLE_MS` (5000), `ACCOUNTING_GROUP_ID` (default `accounting.ledger`; `--group <id>` wins; must match
`^[a-z][a-z0-9_.-]*$` like `consumer_processed.group_id`). The broker's topics must exist
(`infra/redpanda/create-topics.mjs`); the consumer creates `dlq.<group>` itself on first start. A fresh group reads
from the beginning into the SAME ledger: every event it has not processed under that group is posted, so only point it
at a ledger that has not seen those events under another group (Integration 4, #594: a fresh group on the empty dev
ledger).

## Tests

`pnpm --filter @platform/accounting test` — 98 tests in eleven files:

- `src/posting/posting.test.ts` — pure: the arithmetic, the worked example of every topic above, partial shipments,
  proportional refunds and cancellations, every defect class, the netted life of one order, the late shipment, event
  times as instants (fractional seconds, a +02:00 offset, equal instants written differently), the zero-base cancel.
- `src/posting/stream.test.ts` — pure: a generated month (seeded PRNG, 400 orders → 1,464 events over two legal
  entities and two currencies, partial / full shipments, every refund reason, cancellations before and mid-shipment)
  balances per legal entity per currency; the contract liability equals the unreleased part of the open orders.
- `test/ledger.test.ts` — throwaway database (seeded, the landed migrations): one event = one transaction
  with the processed mark, the chart seeded once, the two idempotency guards, a real failure writing nothing, an
  event of another organization refused, shipment / return refund / cancel BEFORE their order parked and applied in
  fact order, a 436-event month balanced in SQL with a second pass that changes nothing, the same month delivered in
  shuffled topic order (every order last) producing the identical ledger, RLS between stores and organizations, the
  processed table append-only for the app role.
- `test/reconcile.test.ts` — the committed payout fixtures equal the builder's output; the pure matcher (every kind,
  the window rule, the window as instants); the clean month on a seeded database: eight payouts reconciled with zero differences and posted,
  the PSP clearing account equal to the open balance to the cent, books balanced, a re-import a no-op; the discrepant
  month on its own database: each kind exactly once, nothing posted for those payouts, a re-import re-matched.
- `test/erp.test.ts` — the JSON-RPC client against the mock (auth, retries with a bound, every refusal class), the sync
  on the clean-month ledger: chart mapped, one posted balanced move per (event, journal), every row marked, a re-run
  creates nothing, a refused move reported while the rest continue and posted on the next run, a crash between create
  and mark recovered by ref, a code map with a missing Odoo account skipping only its entries, a draft left by a crash
  posted before marking, a create with a lost answer recovered by ref (never a second move), `e2e-` legal entities
  refused by the mapping step and the sync, a move cancelled in Odoo reported and never re-posted or marked (and a
  re-entered one found), a create with nothing committed rethrowing; `odoo:init` against the mock (an existing company
  in another currency left alone and skipped, a re-run creating and writing nothing, a remote host refused before any
  call unless `--allow-remote`); a live block for the dev-stack Odoo (skipped with the reason when it is down).
- `src/config.test.ts` — the consumer group: default, env, `--group` in both spellings, invalid names refused.
- `src/api/spec.test.ts` — the contract as loaded (seven reads, all finance, 401/403) and the route matcher.
- `src/api/auth.test.ts` — dev tokens never accepted in production, refused without the flag, accepted with it; an
  unknown subject 401; the permission service unreachable → 503 fail closed; a refusal → the contract's 403.
- `test/api.test.ts` — the API over HTTP on the clean-month ledger with its payouts: 401 / 403 (store admin, analyst)
  / 200 (finance, owner) on every operation, bodies validated against the contract's schemas, filters and pagination,
  trial balance totals at zero, 404 / 400 cases, a log sweep.
- `test/month-replay.test.ts` — the Integration 4 gate above (4 tests; live broker, two throwaway databases).
- `test/consumer-live.test.ts` — the consumer on the local Redpanda (prefixed topics and group, deleted afterwards):
  every event once, a redelivered `outbox_id` writes nothing, an unknown version is skipped, a shipment before its
  order is parked then applied, a genuinely bad shipment dead-letters with `ShipmentExceedsOrder` after the retries
  while the stream continues, a log sweep. Skipped with a printed reason when the broker is down.

Loopback is `127.0.0.1` for the database and the broker (Memory-main: Docker's IPv6 proxy); the vitest config pins
the defaults, CI overrides them.
