# Memory 15 — Automatic accounting

Window: 15 · Key: `accounting` · Branch prefix: `accounting/` · Model: Opus 5.5 since 2026-10-24 (owner switch; was Fable)
Last updated: 2026-10-30 (window 15) · Branch: `accounting/phase5-588-fixes` (cut `--no-track` from main 4d97da6) · Manager: **Manager session ten** · Status: **#639 PR open (code commit 52d56db; head = this memory commit)**; Fable review (money). #645 = PR #651 MERGED 4d97da6.

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

Phase 4, all merged (details: apps/accounting/CHANGELOG.md 0.2.0–0.6.3, the PR bodies, git log):

- 2026-10-23 **#548 15.1 ledger consumer + posting rules** — MERGED 022c13b (integration PR #567, with CONTRACT CHANGE #558 = db 0203). Consumer group `accounting.ledger` on the events-v1 SDK; parking of events before their order; per-order advisory lock.
- 2026-10-23 **#549 15.2 PSP fee matching + payout reconciliation** — MERGED 6b63bd9 (PR #571, incl. the strictly-earlier window fix after the Fable BLOCK).
- 2026-10-24 **#550 15.3 Odoo sync** — MERGED 3550bf0 (PR #574). JSON-RPC client + mock, mapping steps, one move per (event, journal).
- 2026-10-24 **#551 15.4 Finance read API** — MERGED 54e0281 (integration PR #582, with CONTRACT CHANGE #572 = packages/contracts/openapi/accounting.yaml 0.1.0).
- 2026-10-24 **#552 15.5 month replay gate (Integration 4 accounting gate)** — MERGED 859fd96 (integration PR #588 = my ffbeb7e + the manager's #578 CI step; three green CI runs). Runs in every live CI job.
- 2026-10-25 **#575 15.3a Odoo crash cases + odoo:init + e2e exclusion, and #589 15.5a event times as instants** — MERGED bf1710b (PR #591, one PR for both; Opus BLOCK answered in 0d9a2c8: cancelled Odoo moves never re-posted or marked, odoo:init local-only and never rewrites a company). Live proof accepted: throwaway ledger synced into dev Odoo company 5, 148 moves created then 0 on the second pass (the 148 fixture moves stay in dev Odoo company 5).

- 2026-10-25 **Integration 4 (#594) step 2** — accounting on the real dev bus: PR #596 MERGED 9711f22 (consumer group option `ACCOUNTING_GROUP_ID` / `--group`). Results: 149 events handled, 0 parked, 0 dead letters; trial balance zero (Brand A EUR 538,422, Brand B GBP 24,398; Brand C no events); store-admin 403; erp:sync Brand A 147 moves then 0. Details in PR #596.
- 2026-10-27 **#627 dates a day early east of UTC** — PR #630 MERGED 33b8365 (Fable MERGE): every date column `::text`, `date()` throws on a Date, Odoo move date fixed, Dockerfile TZ=UTC, zone test; dev Odoo company 5 moves from 10-24/10-25 are a day early (launch checklist: re-run erp:sync on a clean Odoo).
- 2026-10-25 **The #552 gate on the real relay / replay CLIs** — PR #597 MERGED 0263ad8 (3/3 green CI, gate 4/4): spawns apps/core `relay-cli --once --topic-prefix --throwaway-db` and `replay-cli --topic-prefix` per topic; the wire-function reproduction is gone; relay / replay ceilings 60 s.

## In progress

- **#639 PR (code commit 52d56db; head = this memory commit).** Manager additions applied: parked_event_defect at ERROR level; `stuckParkedEvents(q, le?)` (parked rows whose order exists) asserted empty by the month-replay gate after the live run and the replay; lock comments (the lock tx only holds the lock; a hashtext collision only serialises two entities). LIVE (machine granted 2026-10-30): throwaway DB, fresh generated month (91 events, Brand A 61 refs), two CLI processes at once vs dev Odoo company 5 → process 1 exit 1 after 163 ms ErpSyncInProgress, process 2 exit 0 created 61 / marked 170 / refused 0; third run 0; Odoo 61 refs → 61 posted moves, refs with > 1 move = 0; DB dropped; machine free. FULL suite 108 + 1 skipped (live Odoo), gate 4/4 (relay 1,942 / consume 6,262 / replay 2,400 / replay_consume 4,000 / reconcile 201 ms). Was: **#639 (Fable re-reviews of #588 + #591; package 0.6.8).** (1) tie: shipment-shipped `>` instead of `>=` (a shipment AT the cancel instant counts as shipped before it; pure test both arrival orders; the #589 equal-instants test now asserts `recognised` with the instants swapped so a text compare still fails it). (2) a PARKED event that is a PostingError when order.placed applies it is skipped: stays in accounting_parked_event, `deleteParkedEvents(tx, order, appliedIds)`, `HandledEvent.parked_defects`, consumer logs `parked_event_defect`; other errors still throw. No real DLQ record (SDK deadLetter is internal; option B = REQUEST to window 14, told the manager). DB test in ledger.test. (3) README note: shipping revenue / floor remainder attach to the first-consumed shipment. (4) erp:sync lock: `syncLegalEntity` = `client.transaction` holding `pg_try_advisory_xact_lock(hashtext('erp_sync'), hashtext(le))`, body in `runSync`; overlap → `ErpSyncInProgress`. Test: mock seam `pauseCreates()` holds every create until both runs are in flight (a plain Promise.all did NOT reproduce the race: the in-process mock is too fast); mutant without the lock → the first ref gets 2 moves. Gotcha: `vitest -t` on one erp test skips the mapping tests before it → LegalEntityUnmapped; run the whole file for mutation checks. Offline: 99 + 1 skipped (109 with the broker files), build, root gates, ownership green. NEXT: the machine → scratchpad `live-lock-proof.mjs` (fresh generated month, 2 CLI processes at once vs dev Odoo company 5, a third run, refs counted in Odoo) → PR "Closes #639" with the numbers → manager (number + head sha) → checks.
- Resume checklist for any task: start from a fresh branch off main with `git switch --no-track -c <b> origin/main`; `pnpm install --frozen-lockfile`; build the workspace packages incl. `@platform/test-utils` (new since #617); after any stack restart re-run `pnpm --filter @platform/auth-sdk fga:seed`; warm Odoo with one request before the live ERP block.

## Next

- Nothing assigned: wait for the next manager session (Phase 5 planning).

## Blocked / waiting

- Open follow-ups filed by this window, not in the Phase 4 gate: #559 CONTRACT CHANGE unit cost on shipment.shipped items (COGS), #560 CONTRACT CHANGE payment.disputed (chargebacks) (#561 and #579 closed by #595).
- Live Stripe (test keys, #361): fixture payout reports until then (waiver on #549).
- The dev ledger now holds the Integration 4 run (group `accounting.ledger.int4`; Brand A synced to Odoo company 5, Brand B not synced). A future dev run must use another fresh group only on a fresh ledger, or the same int4 group (it dedupes).

## Decisions made (with reasons)

- 2026-10-23 (window 15, #550): **Odoo ref = `<source_event_id>/<journal>`** (an event can post two journals — shipment: sales + shipping — and Odoo wants one journal per move); **a move is posted only in the company's currency** (shipment cost in another currency is skipped with `currency_unsupported`; no FX this phase); **the mock is a JSON-RPC server, not an adapter stub**, so the real client's request shapes, auth and fault mapping are what the tests exercise; **a 5xx is a transport failure** (retried, then `OdooTransport`), an Odoo fault is never retried.
- 2026-10-23 (window 15, #549 fix after the Fable BLOCK on #571): **a payout's window start comes only from payouts strictly EARLIER by (arrival_date, provider_payout_id)** — `l.payout_id <> $2` let later payouts widen the window, so a re-import of an older discrepant payout came out clean and POSTED; `reconcileAll` sorts oldest first; a second-pass test on the discrepant month pins it (fails on the old code).
- 2026-10-23 (window 15, #549): **payouts match per (legal entity, provider)**: only accounting_payment rows of the report's provider are candidates and the window of earlier payouts is that provider's. **Unmatched ledger lines are found per payout window** — from the latest ledger time an earlier payout matched (exclusive) to the latest this payout matched, kept PER TYPE (captures settle +2 days, refunds at once; one window mixed them and misreported) — so a missing capture is reported exactly once, by the payout that should have carried it. **A discrepant payout posts nothing** (status discrepant, lines kept with their verdict); re-import re-matches it. **The payout posting carries store_id NULL** (a payout spans stores; manager). **Fixture determinism**: generateMonth(deterministicIds) seeds every id incl. event ids and display ids; a test compares the committed files with the builder's output.
- 2026-10-23 (window 15, #548): **line net = total_minor − tax_minor; shipping net = total − tax − Σ line net** (the remainder) so every placed entry balances by construction in both price modes and rounding drift lands in 2310, never in an imbalance. **Release per line = floor(net × cumulative shipped / qty) − released so far**, remainder on the last units. **Shipping released with the first shipment.** **Refund tax part = round-half-up(amount × order tax / order total)**; reason `cancellation` posts Dr 1200 / Cr 1100 (the cancel already reversed the sale). **Cancel reverses the unreleased remainder** from the projection, ignoring the event's totals. **Missing projection = PARK** (manager 2026-10-23: a fresh-group replay reads all topics at once, a hand-emptied DLQ would break #552's second-replay-no-op): `accounting_parked_event` + mark in one tx; order.placed applies the order's parked events in envelope occurred_at order and deletes them; a parked event that fails on apply fails the order.placed (→ DLQ with that class). DLQ for defects only; #552 needs no topic order. **Lines are netted per account per event** so UNIQUE (source_event_id, account_code) never fires on a legitimate entry. **Payout postings (#549) will use psp_payout.id as source_event_id with source_topic `psp.payout`** (no outbox event exists for a payout).
- 2026-10-23 (manager, kickoff — full text on #548–#552): tables in packages/db, manager-landed (integration landing: manager's db commit on `integration/<name>`, you cut your commit from that sha); shared `consumer_processed` (db 0202) landed by the manager before your first PR, markProcessed in the ledger's own transaction; revenue recognised at shipment (order.placed → contract liability), the accountant validates the chart before launch; COGS and chargebacks out of the gate (no cost field, no dispute event) — file the CONTRACT CHANGEs that would add them; per-currency balance, no FX conversion this phase; Stripe and Odoo live use waived to the launch checklist until keys / an instance exist.

## Gotchas learned

- The consumer SDK dead-letter path crashed once with `producer` undefined (`Cannot read properties of undefined (reading 'send')`) when `stop()` raced an in-flight dead letter during afterAll — harmless for the gate (nothing dead-letters any more), worth a nit to window 14.
- kafkajs redelivers a batch after a rebalance (slow handlers → session timeout): `duplicates` in the SDK stats are normal on a shared machine; assert handled counts and ledger counts, never `duplicates: 0`.
- Lockfile churn on every clean `pnpm install` here (medusa admin-bundler / admin-vite-plugin / fdir / picomatch / @vitest/mocker jiti peer keys flip): the manager wants only our lines. Recipe that passes `pnpm install --frozen-lockfile`: take the BASE's lockfile (`git show <base>:pnpm-lock.yaml`), insert only the apps/accounting importer lines (specifier + version per dependency; yaml/ajv/ajv-formats package entries already exist in the lockfile), write it back (scratchpad/fix-lockfile.mjs). Never hand-edit snapshot keys.
- JavaScript `String.replace` with a replacement STRING expands `$'`, `` $` ``, `$&`, `$1`: a yaml regex pattern `'^[A-Z]{3}$'` in the replacement text pasted the whole rest of the file into the middle (10-23, one lost turn). Always pass a function replacer `() => text` in scripted edits.
- ajv / ajv-formats under NodeNext ESM arrive as a module object with `default` (no construct signature): unwrap `m.default ?? m` and cast (test/api.test.ts); auth-sdk `can()` wants its `PermissionRelation` type — cast the yaml string with `as Parameters<typeof can>[1]`.
- `s.match(re)` without /g returns the capture groups, not the match count — count with /g in scripted edits.
- Fixture envelopes: `makeEvent` stamps occurred_at = now; pass `occurredAt: new Date(<fact ts>)` or parked events apply in construction order, not fact order (bit me once).
- The generator's `day` advances every `ordersPerDay` orders (default 7): 40 orders cover six days — spread a fixture month with `ordersPerDay: 2` or payouts after week one are empty.
- A test that shares one database across describes leaks state (a rolled-back parked pair, an earlier provider's payout lines): scope counts to the test's own ids or give the describe its own database.
- Column-level GRANT UPDATE (a, b) on a table with a BEFORE UPDATE trigger that sets updated_at works: the trigger's assignment is outside the statement's privilege check (tested 10-23).
- The accounting tables are `organization_only`: a store-scoped client reads NOTHING of them; every accounting test and the Finance API (#551) must use the organization client.
- Rebasing a side branch onto a squashed cut: `git rebase --onto <new-base> <old-base> <branch>` replays only the side commits; the memory file conflicts every time (take the new base's and re-apply the side notes with a script).
- NEVER chain `cd <dir> && …` after a fallible step in one Bash call: when the step fails the `cd` is skipped and the later commands run at the repo ROOT — on 10-23 that ran the whole repo's vitest (events live tests included) by accident. Use a subshell `( cd apps/accounting && … )` or absolute paths. Same family: a failed inline `node -e` skipped the memory update and the PR-body edit while commit + push + PR creation still ran (they were after a `;`). One fallible step per `&&` chain, scripted edits as .mjs files (double-quote strings that contain apostrophes), never inline with Windows paths.
- Cutting from an integration sha with `git checkout <old-branch> -- apps/accounting` also reverts files main changed meanwhile (the Dockerfile, window 5): re-checkout those from the base afterwards and diff the base.
- A PR cut from an integration landing contains the manager's packages/db commit: the branch-prefix ownership check (local and CI) flags those files; expected — the manager's landing mechanics (integration PR / fast-forward) resolve it, say so in the PR body.
- `createPgProcessedStore` inserts (group_id, outbox_id) only → 0202 has `organization_id DEFAULT app.current_organization_id()`, RLS `organization_only` (a store session sees none), UPDATE revoked, DELETE kept, `group_id ~ '^[a-z][a-z0-9_.-]*` (test group ids must match).
- Tests on the shared broker: pass `groupId: `${prefix}accounting.ledger`` + `topicPrefix` so a test never joins the real group; the SDK does NOT prefix the group id itself.
- Prettier is not part of `pnpm lint`: run `npx prettier --write apps/accounting` before committing (CI has `format:check`).
- No python on this machine: scripted edits with node (`node script.mjs`), see the scratchpad pattern.
- `pg` returns bigint as strings; `Number()` every amount read from SQL.
- (from Memory-main, read its Global gotchas) loopback 127.0.0.1 for DB and broker; rebuild workspace packages after every merge of main (stale dist); order tests need more than ten rows (text-sort bug class, #543).
- 2026-10-24: a `String.replace` with a FUNCTION replacer does not expand `$1`: a capture-group replacement written as `() => '$1 …'` inserts the literal `$1` and drops the captured text (it broke sync.ts once). Use explicit text, or a string replacer only when no `$` sequences are meant literally.
- 2026-10-24: a long heredoc with nested quotes and backticks fails in the Bash tool (`unexpected EOF`); write the .mjs with the Write tool into the scratchpad and run it with node.
- 2026-10-24: after a Docker restart the first Odoo request is slow (registry load) and the live ERP probe (2 s) skips the block; one warm-up request first. OpenFGA (in-memory) loses its store: re-run fga:seed.
- 2026-10-24: during a pause or review freeze, commit memory notes on a LOCAL branch (not the PR head); they ride along with the next allowed push.

## How to run & test this package

- Setup once per worktree: `pnpm install --frozen-lockfile`, `pnpm turbo run build --filter=@platform/auth-sdk --filter=@platform/db --filter=@platform/events --filter=@platform/contracts`, `pnpm --filter @platform/auth-sdk fga:seed` (done 2026-10-23).
- Package: `pnpm --filter @platform/accounting test|typecheck|lint`; DB tests need the stack (Postgres 127.0.0.1:5433), broker tests need Redpanda 127.0.0.1:19092 (skip with a printed reason otherwise).
