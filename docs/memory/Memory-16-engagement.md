# Memory 16 — CRM, CDP, ops alerts & support
Window: 16 · Key: `engagement` · Branch prefix: `engagement/` · Model: Sonnet
Last updated: 2026-10-23 (window 16, session one) · Contracts: contracts-v0.4.26, events-v1 = 2abe310 · Last commit: see Done/In progress · Status: 16.1 delivered (PR #562, head a2e9abc, pushed); 16.2 BUILT and green locally (166/166 with the broker up, twice); pushes HELD until the manager confirms #562 merged

## Identity (does not change)
Owned paths (write):
- `apps/engagement/**` (new service, created by you in #553)
- `apps/support/**` (reserved; support lives in apps/engagement/src/support this phase)
- `data/cdp/**`
Reads:
- everything; especially packages/events (events-v1 consumer SDK), apps/notifications (window 17's transactional email — the model for transports and exactly-once, NOT yours), auth-sdk, docs/adr/0003-outbox-events.md item 5 (no PII in events)
Never touches:
- apps/notifications (window 17), core, accounting, packages/* (CONTRACT CHANGE / REQUEST issues instead)

## Mission — Phase 4 (Events, accounting, CRM)
Bus consumers for engagement, each an adapter + dev sink/mock (no external accounts exist): ops alerts to Slack, a CDP tracking plan + RudderStack mapper, CRM sync (Twenty), a support-context API for agents (Chatwoot-shaped). Consent-gated, erase-aware, no PII from events.

## Done
- **#553 16.1 apps/engagement service + ops alerts — PR #562 (code commit d186210; head = this memory commit)** (open 2026-10-23, checks running; `Closes #553`; the record form the manager asked for). Branch engagement/phase4, 5 commits: 065d0a3 service + ops alerts · fe9f910 merge main 653d817 · 1e1a9d8 drop the 0202 copy (#557 landed) · f6824f6 memory · d186210 live-test isolation + a dedupe test that actually tests dedupe.
  Delivered: `@platform/engagement` 0.1.0 at apps/engagement — `src/ops/{rules,consumer,rate-limit,dlq-watch,store-codes}.ts`, `src/transport/{types,dev-sink,slack}.ts`, `src/{config,main,types,index}.ts`, README + CHANGELOG + CLAUDE.md, scripts dev/start/once. Group `engagement.ops` over payment.failed / refund.failed / return.requested on the events-v1 SDK, marks in the shared `consumer_processed` via `createPgProcessedStore` + an organization-scoped client; 4 rules (incl. `dlq-depth`); dev JSON-lines sink + Slack webhook; rate limit per (rule, store); DLQ depth poll.
  Verified: **71/71 on three consecutive full-suite runs** with the broker up (~26 s each, "deleted 12 topic(s) with prefix t-eng-<random>" + the afterAll assertion that none remains); 68 passed / 3 skipped with the broker unreachable (the printed-reason path); package + root typecheck (24/24), root lint, check-ownership OK, prettier clean. Machine was granted for the live run and released.
  Manager rulings on the record: post-then-mark ACCEPTED (at-least-once for alerts is the right trade, keep the header + README wording); `return.requested.reason` excluded and PSP `failure_reason` included ACCEPTED, both to stay asserted.
  NEXT: `app images` is expected RED until the manager's Dockerfile COPY commit — he cuts `integration/engagement-service` from this memory commit (he asked for it pushed, 2026-10-23), adds the lines, and THAT integration PR merges, not mine. **Hold all pushes from there**; #554 may be built in the working tree, local only, until he confirms #562 merged. Message him when every check has finished.

### The live-test trap this task cost me two runs to find (read before writing 16.2's consumer test)
- Every live test that uses `createOpsConsumer` joins the REAL group (`engagement.ops`, and 16.2 will be `engagement.cdp`). Two live members of one group SHARE the topic's partitions, so a message published by test C can be delivered to test A's consumer — whose transport behaves differently — and the assertion then tests the wrong object. The dead-letter test passed alone (15/15) and failed in the full-suite run for exactly this reason. Rule: **each live test ensures its own topics under a sub-prefix and stops its consumer in a `finally` before the next starts** (`run(consumer, async () => {...})` helper in ops/consumer.test.ts).
- Worse, fixing that exposed a test asserting the right outcome for the wrong reason: "a restarted consumer sends nothing" was passing on committed OFFSETS, not on the dedupe marks, because the file's `beforeEach` wipes `consumer_processed` — it would have passed with the processed store deleted entirely. Rewritten as "sends nothing for events already marked for this group": fresh topics (no committed offset), two events, ONE pre-marked, assert only the unmarked one alerts. The unmarked one proves the consumer reads the topic; the marked one proves the mark is what silences it. **Copy this shape for 16.2/16.3 — a dedupe test that cannot fail when dedupe is removed is not a dedupe test.**

### 16.1 design decisions worth not re-deriving
- **post THEN mark**, the reverse of apps/notifications: a Slack post cannot join the mark's transaction, so a redelivery sends nothing (the SDK checks `consumer_processed` before the handler) but a crash in the gap can repeat ONE alert. Mark-first would lose it instead; for ops alerts a duplicate is cheap and a miss is an unseen incident. Flagged to the manager, who did not object. In the consumer header + README.
- **`return.requested.reason` is never in a message**: free text a customer or agent typed, the one PII vector in these three topics. The PSP's `failure_reason` on payment/refund IS included (a provider reason code). Asserted both ways in rules.test.ts, so a change there has to be deliberate.
- The PII sweep strips uuids AND RFC-3339 timestamps before the phone/hash regexes — they are what an alert is made of and any loose phone pattern matches them (cost me two red runs).
- `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` are on in tsconfig.base: index with `!` in tests, and pass optional options through conditional spreads (`...(x === undefined ? {} : { x })`), never `x: opts.x`.
- `Kafka` is NOT exported by @platform/events; kafkajs is not a dependency here. Use `ReturnType<typeof createKafka>` (type-only import).
- The consumer handler gets `EventEnvelopeV1Base` (payload `{}`), not `EventEnvelope<T>`; rules take the base type and cast the payload after checking `envelope.topic`.
- No table of my own: marks are the shared table's, the rate-limit window is in memory (documented: one worker per organization, a restart forgets it), an alert lives only in the transport.
- eslint allows only console.warn/error/info — a JSON log line goes through `console.info`.
- vitest config must set DATABASE_URL/DATABASE_URL_APP in `test.env` (turbo strips DATABASE_URL* from the test environment) and `fileParallelism: false`, copied from apps/notifications.

## In progress
- **#554 16.2 (CDP) — BUILT and green, LOCAL COMMITS ONLY. Plan approved by the manager 2026-10-23; the live block was run with the machine he granted. Waiting on #562 merging before anything is pushed.**
  Delivered: `data/cdp/tracking-plan.json` + `data/cdp/README.md` (9 mapped topics, 29 unmapped with reasons, all 38 contract topics accounted for exactly once); `apps/engagement/src/cdp/` = `mapper.ts` (pure), `consent.ts` (the only DB-touching CDP file), `consumer.ts` (group `engagement.cdp`), `types.ts`, `adapter/{memory,rudderstack}.ts`; config + main wiring (`ENGAGEMENT_CDP_ENABLED` defaults to 0); package 0.2.0, README + CHANGELOG + CLAUDE.md updated.
  Test state: **166/166 with the broker up, on two consecutive full runs** (both live blocks self-cleaning: "deleted 30 topic(s)" cdp + "deleted 12 topic(s)" ops, each asserting none remains); 160 passed / 6 skipped with `KAFKA_BROKERS=127.0.0.1:19099`. Per file: mapper 25, consent 25, adapters 18, cdp consumer 16 (13 DB + 3 live), ops rules 16, transports 13, config 24, dlq-watch 8, rate-limit 7, ops consumer 15. Package lint + typecheck clean, prettier clean, check-ownership OK.
  Manager rulings applied: tenant client per event for the consent read + organization client for the marks; the conservative gate IS the Phase 4 rule (no identify/track without granted `marketing_email`, guests DROPPED) and **no `cdp_analytics` CONTRACT CHANGE is to be filed** — it is a legal question on the owner's lawyer list, written in `data/cdp/README.md` as a deliberate default pending that answer; ignoring the payload's `marketing_consent` in favour of the projection accepted and written in those words; the mapped topic set accepted.
  STILL TO DO: push (held), then PR for 16.2 with the acceptance criteria; then #555.

### #554 findings worth not re-deriving
- **A tenant client alone cannot carry a bus consumer.** `consumer_processed` is `organization_only`, so a store-scoped client reads and writes none of it (asserted in 16.1's test). The CDP consumer therefore needs TWO clients: the organization one for the marks, a store-scoped one for the consent read.
- **An organization client could do both**: `app.can_access_store` (0001) returns true for ANY store when `app.current_scope() = 'organization'`, so organization scope reads `customer` (RLS kind `store`) across every store. Using a store-scoped client for the consent read is therefore a deliberate least-privilege choice, not a requirement — consent is per (customer, store, purpose) and 0194 says never propagated across stores, so scoping to the event's own store makes a cross-store consent read structurally impossible.
- **`customer.created` / `customer.updated` carry `marketing_consent` in the payload — and the mapper must IGNORE it** (manager ruling: current consent at processing time). A `track` decision can therefore contradict the event's own snapshot, correctly. Said so in the README in those words, and a test asserts the two events yield identical traits whatever that field says.
- **The five order-scoped topics carry NO identity** (`order.cancelled`, `payment.captured`, `refund.issued`, `shipment.shipped`, `return.requested`): no `customer_id`, no `email_hash`. The customer comes from the `"order"` row — in the SAME query as the consent projection (`readOrderCustomerFacts`), so identity and permission are one read, never two sources of truth.
- **Fixture traps the schemas caught for me** (validate every fixture with `createValidator().validateEnvelope`, it pays for itself): `order.placed.shipping` is `{code,name,carrier,price_minor}`; `order.cancelled.totals` needs all five fields; `refund.issued.reason` is an ENUM (`return|cancellation|goodwill|chargeback`) while `order.cancelled.reason` is free text; `order.confirmed` needs `display_id`; `product.published` needs `category_id`/`variants`/`published_at`; `"order"` has NO `legal_entity_id` and needs `sales_channel_id` + both address jsonbs; `makeEvent`'s `storeId` is REQUIRED (`string | null`), not optional.
- **Never commit a 64-hex email_hash fixture.** The `sha256` $def needs a real 64-hex value, so a word will not validate — compute it: `createHash('sha256').update('…').digest('hex')`, which is what apps/core does. I had three such literals before catching it; one would have reddened every open PR.
- `pg` is deliberately NOT a dependency of this app: for a pool type use `Parameters<typeof createTenantClient>[0]`.

## Next — Phase 4 (issues, in order)
- [x] #553 16.1 apps/engagement service + ops alerts (group `engagement.ops`) — PR #562, see Done
- [ ] #554 16.2 CDP tracking plan + RudderStack mapper (group `engagement.cdp`)
- [ ] #555 16.3 CRM sync, Twenty adapter (group `engagement.crm`; REQUEST a crm-sync service client)
- [ ] #556 16.4 Support context API + Chatwoot webhook stub

## Decisions made (with reasons)
- 2026-10-23 (manager, kickoff — full text on #553): apps/notifications stays with window 17 (it built transactional email there since #360); your row is apps/engagement, apps/support, data/cdp. One new service apps/engagement; the manager lands its Dockerfile manifest lines as an integration commit on your 16.1 head. Shared `consumer_processed` (db 0202) via the SDK's pg store. SMS/WhatsApp (Twilio), Novu, Klaviyo flows DEFERRED until accounts exist; returns portal + refund limits by role are a later wave (core/auth/storefront/admin), not yours.

## Blocked / waiting
- **The machine for the live broker block** (one window measures at a time; window 15 also active). Asked the manager 2026-10-23: 3 tests, prefixed `t-eng-<random>.` topics, self-cleaning, ~60-90 s. Note `pnpm test --filter @platform/engagement` AT ROOT runs the live block too whenever the broker is up — so that root command is itself the live run, not a safe pre-check.
- ~~db 0202~~ **RESOLVED 2026-10-23: #557 merged** (main 653d817, packages/db 0.3.16); the landed file is byte-identical to the one I built against, so the copy and `applyProposedMigration` are deleted (1e1a9d8) and `createTestDatabase` applies the real migration. Its shape, asserted in my tests from the consumer's side: RLS `organization_only` (a store-scoped client reads nothing and cannot insert → the consumer MUST use createOrganizationClient), `organization_id` DEFAULT app.current_organization_id() (the SDK's two-column INSERT works), PK (group_id, outbox_id), UPDATE revoked from platform_app, group_id CHECK `^[a-z][a-z0-9_.-]*$` (so `engagement.ops` is fine).
- ~~.gitignore row for `.engagement/`~~ **RESOLVED: on main in 653d817** (the manager added it; he also chose the name and `ENGAGEMENT_DIR`).
- External accounts (Slack webhook, RudderStack, Twenty/HubSpot, Chatwoot): mocks until the owner provides them; live use on the launch checklist.

## Gotchas learned
- (from Memory-main, read its Global gotchas) loopback 127.0.0.1 for DB and broker; rebuild workspace packages after every merge of main (stale dist); a new workspace package breaks `app images` until every Dockerfile COPYs its manifest — the manager lands mine, I never touch a Dockerfile.
- The `app images` manifest rule bit nobody yet because I did not add the COPY lines; do not "help" by editing infra.
- gitleaks: I nearly committed a real 40-hex sha1 as an email_hash fixture. Replaced with `emailhash-of-ada-not-hex`. Any long hex literal in a test is a repo-wide CI outage waiting to happen.

## How to run & test this package
- Worktree setup, every session: `pnpm install --frozen-lockfile` → `pnpm build --filter "./packages/*"` → `pnpm --filter @platform/auth-sdk fga:seed` (memory datastore: re-seed after an OpenFGA restart).
- apps/engagement: `pnpm --filter @platform/engagement dev` (consumer + DLQ poll) / `once` (one DLQ poll, exits).
- Tests: `pnpm --filter @platform/engagement exec vitest run` — add `KAFKA_BROKERS=127.0.0.1:19099` to run everything EXCEPT the live block (68 pass, 3 skip) without taking the machine.
- Before finishing a task: `pnpm lint && pnpm typecheck && pnpm test --filter @platform/engagement` (the last one needs the machine) and `bash scripts/check-ownership.sh`.
