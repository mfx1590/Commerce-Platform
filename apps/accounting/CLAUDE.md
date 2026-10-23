# @platform/accounting

## Purpose

The ledger service (Phase 4). One bus consumer, group `accounting.ledger`, on the events-v1 consumer SDK
(`createConsumer` from `@platform/events`) over `order.placed`, `order.cancelled`, `payment.captured`, `refund.issued`,
`shipment.shipped` (ADR 0003 item 6). Every event becomes one balanced journal entry per journal — `ledger_entry` rows
with the same `source_event_id`, debits = credits per currency — written in ONE transaction with the processed mark.
Revenue is recognised at shipment: `order.placed` posts receivable vs contract liability + VAT, `shipment.shipped`
releases the liability line by line from the service's OWN order projection (never a read of core tables). Since #549
PSP fee matching + payout reconciliation from fixture reports (`src/reconcile`, journal `bank`). Since #550 the Odoo sync (`src/erp`, JSON-RPC + mock; live waits for the owner's instance). Next:, the Finance read API (#551), the month replay gate
(#552). README.md has the chart, the posting rules and a worked example per topic.

## Owner

window 15 (accounting). Writes only `apps/accounting/**`; tables come from CONTRACT CHANGE issues (#558 → db 0203, landed),
landed by the manager in `packages/db`.

## Run / test

- `pnpm --filter @platform/accounting dev | start | once` — the process (`src/main.ts`): app-role pool,
  organization-scoped client (`CORE_ORGANIZATION_ID`, default the seeded HQ), the consumer, `GET /health` on `PORT`
  (9003). `once` stops after `ACCOUNTING_ONCE_IDLE_MS` (5 s) without a batch. Needs the stack (Postgres 5433, Redpanda
  19092 with the topics created) — `KAFKA_BROKERS`, `DATABASE_URL_APP` from the root `.env`.
- `pnpm --filter @platform/accounting test` — Vitest: pure posting tests (`src/posting/*.test.ts`), the throwaway
  database tests (`test/ledger.test.ts`, seeded via `@platform/db/testing` + `test/helpers/db.ts`) and the
  local-broker test (`test/consumer-live.test.ts`, prefixed topics
  and group, self-cleaning; skipped with a printed reason when the broker is down).
- `pnpm --filter @platform/accounting reconcile -- --fixtures <dir> --legal-entity <uuid> [--payout <id>]` — payout
  reconciliation from fixture reports (after `build`); exit 2 when a payout is discrepant. `pnpm --filter
@platform/accounting fixtures:payouts` rebuilds the committed fixtures.
- `pnpm --filter @platform/accounting erp:sync -- --legal-entity <uuid> [--company <id>] [--mock]` — Odoo sync
  (after `build`); credentials from `ODOO_URL` / `ODOO_DB` / `ODOO_USER` / `ODOO_API_KEY`; `--mock` = in-memory Odoo.
- `pnpm --filter @platform/accounting typecheck | lint | build`.
- Root: `pnpm lint && pnpm typecheck && pnpm test --filter @platform/accounting` before finishing any task.

## Public API (`@platform/accounting`)

- `createLedgerConsumer({ client, kafka?, topicPrefix?, groupId?, log?, retries?, fromBeginning?, sleep?, onBatch? })`
  → the SDK's `EventConsumer` (`start` / `stop` / `stats` / `dlqTopic`); `LEDGER_GROUP`, `LEDGER_TOPICS`,
  `LEDGER_RETRIES` (5), `PROCESSED_TABLE` (`consumer_processed`).
- `handleLedgerEvent(client, decodedMessage, { markProcessed? })` (one transaction, `pg_advisory_xact_lock(hashtext(order_id))` first) → `{ action: posted | parked | noop | ignored, entries,
lines, applied_parked, legal_entity_id, outbox_id, topic }` (`parked` = the order has not arrived; the envelope waits
  in `accounting_parked_event`); throws a named defect (`ShipmentExceedsOrder`, `UnknownOrderLine`,
  `ShipmentOfCancelledOrder`, `DuplicateOrderPlaced`, `InvalidEvent`, `ForeignOrganization`, `UnbalancedEntry`,
  `AccountCollision`) — the SDK records the name in the DLQ.
- Pure posting: `postEvent(envelope, orderProjection | null)` → `{ entries, order?, payment?, refund? }`, and per topic
  `postOrderPlaced`, `postShipmentShipped`, `postPaymentCaptured`, `postRefundIssued`, `postOrderCancelled`.
- Reconciliation (#549, `src/reconcile`): `reconcilePayout(deps, legalEntityId, payoutId)` / `reconcileAll(deps,
legalEntityId)` with `deps = { client, source: PayoutSource, log? }` → `ReconcileResult { status: reconciled |
discrepant, already_reconciled, lines, matched, discrepancies[], posted }`; `matchPayout` (pure); `createFixtureSource`,
  `loadFixtureDir`; `pspClearingBalance`; the fixture builder `buildPayoutFixtures` (`pnpm fixtures:payouts`).
- ERP sync (#550, `src/erp`): `ErpAdapter`; `OdooJsonRpcClient(creds, { fetch?, timeoutMs?, retries? })`,
  `odooCredentialsFromEnv()`; `createMockOdoo(opts)` (JSON-RPC server in memory: `fetch`, `state`, `refuseNextCreate`,
  `archiveAccount`); `mapLegalEntityToCompany`, `mapChart`, `syncLegalEntity(deps, legalEntityId)` → `ErpSyncResult`;
  `DEFAULT_JOURNAL_CODES`, `toCurrencyUnits`, `ErpError`.
- `ACCOUNT` (codes), `DEFAULT_CHART`; `ensureChart`, `insertJournalEntry`, `trialBalance`, `balanceByCurrency`;
  the projection readers/writers.
- Tables (0008 + 0203, landed as db 0.3.17 from CONTRACT CHANGE #558): `ledger_entry` (journals `sales`, `psp_fees`, `refunds`,
  `cogs`, `tax`, `shipping`, `bank`; `store_id` NULL on legal-entity-level lines such as payouts; the app role can
  never DELETE a line and may UPDATE only `posted_to_erp_at` / `erp_reference`), `ledger_account` (no DELETE),
  `accounting_order` / `accounting_order_line` / `accounting_payment` / `accounting_refund` (payment and refund rows
  are never deleted), `accounting_parked_event` (deleted when applied), `psp_payout` / `psp_payout_line` (lines never
  deleted; #549); `consumer_processed` (0202, shared). EVERY accounting table is RLS `organization_only`: a
  store-scoped session reads and writes none — the service runs in organization scope.

## Constraints

- Import other packages only through their public API (`@platform/<name>`), never `src/*`.
- No secrets in code. No PII in logs (JSON lines: ids, counts, amounts, error classes). Every DB access through the
  `@platform/db` scoped client (organization scope here); never the owner URL at runtime.
- The ledger is derived from events only: no route, job or UI action writes `ledger_entry`; amounts come from the
  payload and the service's projections, never from core tables.
- Money is integer minor units; a posting function is pure (no I/O, no clock) and returns balanced entries or throws.
- Update README.md and CHANGELOG.md with every change.

## Gotchas

- The five topics are separate partitions: a shipment / refund / cancel can arrive before its order. The handler
  PARKS it (`accounting_parked_event` + the processed mark, one transaction) and the order.placed handler applies the
  order's parked events in occurred_at order, then deletes them. Never retry-then-DLQ for lag: the DLQ is for defects.
- `createPgProcessedStore` inserts `(group_id, outbox_id)` only: `consumer_processed.organization_id` needs
  `DEFAULT app.current_organization_id()` (0202 has it).
- Tests on a shared broker: pass `groupId` + `topicPrefix` so a test never joins the real `accounting.ledger` group.
- `pg` bigint columns arrive as strings: every amount read from SQL goes through `Number()`.
