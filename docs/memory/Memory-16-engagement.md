# Memory 16 — CRM, CDP, ops alerts & support
Window: 16 · Key: `engagement` · Branch prefix: `engagement/` · Model: Sonnet
Last updated: 2026-10-23 (window 16, session one) · Contracts: contracts-v0.4.26, events-v1 = 2abe310 · Last commit: see Done/In progress · Merged: #553 via #563 (7c41d82) · Status: 16.1 delivered (PR #562, head a2e9abc, pushed); 16.2 BUILT and green locally (166/166 with the broker up, twice); pushes HELD until the manager confirms #562 merged

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
- **#553 16.1 apps/engagement service + ops alerts — MERGED 2026-10-23.** PR #562 (code commit d186210; head = the memory commit a2e9abc) went in through the manager integration PR **#563 = 7c41d82**, which added the Dockerfile COPY lines (f0a1d59, check-image-manifests 17/17); #553 closed. My PR itself was marked merged, not merged directly — the integration PR is what lands a new service. Branch engagement/phase4, 5 commits: 065d0a3 service + ops alerts · fe9f910 merge main 653d817 · 1e1a9d8 drop the 0202 copy (#557 landed) · f6824f6 memory · d186210 live-test isolation + a dedupe test that actually tests dedupe.
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
- **#556 16.4 (support context + Chatwoot webhook) — BUILT, 317/9 offline, committed LOCALLY as 70f1118. Waiting for the machine for the live run, and for #568 to merge before its PR.** That is all four issues built.
  Delivered: `src/support/` = `auth.ts` (the two gates), `admin-api.ts` (three reads, each with the AGENT's header), `context.ts` (pure normalisation + summary), `chatwoot.ts` (HMAC + freshness + seen-once), `server.ts` (node:http, three routes), `types.ts`; config + main wiring (`ENGAGEMENT_SUPPORT_ENABLED` defaults 0); `@platform/auth-sdk` added as a dependency; package 0.4.0; README + CHANGELOG + CLAUDE.md.
  **CONTRACT CHANGE #569 ACCEPTED** (listOrders `customer_id`, Admin API 0.4.24, landed on integration/orders-customer-filter a2e6e98; window 1 adds the core predicate). Built against it.
  **#568 = Fable MERGE**; its three nits folded in here (see below).

### #556 decisions worth not re-deriving
- **The agent's OWN token reads**, never a service principal — the opposite of #555, because #556 has a human in the request. Gate order: authenticate → resolve store → `support` on THAT store via OpenFGA → read. 401 lands before a query parameter is parsed, so the route cannot be probed for which stores/customers exist; a test asserts a refused gate makes NO Admin API call, another that every read carried the agent's header. The agent's header is forwarded so the CORE re-checks: defence in depth, and if they disagree the core wins.
- **OpenFGA unreachable → 503, not 403.** "Forbidden" would be a lie; we cannot tell. Same choice auth-sdk's own guard makes.
- **A customer of another store gets the SAME 404 as a non-existent one** — the route must never reveal that an id exists elsewhere in the organization.
- **Nothing cached, `cache-control: no-store` on every response**: a cache is both a stale permission and a copy of PII.
- `getOrder` already EMBEDS payments/refunds/shipments/returns, so the history is one list + one detail per order; `support` implies `viewer` in the model, so one grant covers all three reads.
- **The webhook resolves and persists NOTHING by ruling**: a webhook has no agent token, #556 forbids a service principal here, and a link table is not ours. 202 + `persisted: false`. Replay = freshness window (no timestamp → REJECT, never wave through) + in-memory seen-once LRU, limits documented; it is enough only because the stub has no side effect to replay. Do not add a lookup here.
- The contact address is hashed ON ARRIVAL in the webhook, so nothing downstream ever holds it.

### #568's three nits (folded into #556)
- A Twenty DELETE that 404s after a successful lookup is **already gone**, not a failure — a real race, and previously an erasure could fail for having already succeeded. Matching call on the write path: 404 on PATCH is RETRYABLE (the retry POSTs), 404 on POST stays fatal (wrong base URL, not a race).
- The read-only claim is now an **md5 over every row** of order/refund/customer, and the test asserts the checksum notices a one-column change. Counts + max(updated_at) was weaker than the wording.
- `by_currency`/`mixed_currency` stop at the `CrmContact` boundary — documented on the type and in the README; the log line is the only place that says the two contact fields differ in scope.
- **#555 16.3 (CRM sync) — BUILT and VERIFIED: 252/252 with the broker up (~78 s, three live blocks self-cleaning: ops 12 topics, cdp 30, crm 21); 243/9 offline. Main merged (efc11b2). Pushing + PR now.**
  Delivered: `src/crm/` = `rollup.ts` (pure), `read.ts`, `admin-api.ts` (the only PII read, injected `TokenProvider`), `consumer.ts` (group `engagement.crm`), `types.ts`, `adapter/{memory,twenty}.ts`; config + main wiring (`ENGAGEMENT_CRM_ENABLED` defaults 0, `KNOWN_GROUPS` gains `engagement.crm`); package 0.3.0; README + CHANGELOG + CLAUDE.md.
  **REQUEST #565 (crm-sync service client) ACCEPTED** and routed to window 2 (client export, generalised additive ensure-service-account, FGA via assignRole per store); the `staff_user` seed row is the manager's. NOT on #555's path: built against `mockTokenProvider`, and `ENGAGEMENT_CRM_TOKEN_PROVIDER=client_credentials` THROWS rather than falling back, so its absence cannot become a silent no-op. The live service-account call is a launch-checklist item for the PR body.

### #555 decisions worth not re-deriving
- **The rollup RECOMPUTES, it does not accumulate.** `+1 order` against a counter cannot tell a redelivery from a second order and the bus is at-least-once + replayable, so any replay would double-count undetectably. Recomputing from the customer's own rows is idempotent by construction (a test handles one event twice and asserts an identical contact) and keeps the service stateless. Cost: one bounded read per event; if a customer ever has thousands of orders it becomes a SQL aggregate, and the pure function is why nothing else changes.
- Rollup sub-rules, all with reasons in rollup.ts: a cancelled order is NOT counted at all (not netted to zero); only a `succeeded` refund reduces revenue; a refund against a cancelled order is not subtracted; net is FLOORED at 0 (over-refunds are reachable via goodwill and order edits) with gross/refunded kept unclamped; currencies are never summed — headline is `store.default_currency`, `mixed_currency` flags the rest.
- **Upsert by our `customer.id`, never by e-mail** (#555): an address changes and two people share one. Twenty has no upsert verb, so find-by-external-id then PATCH/POST — and an unreadable lookup must FAIL, never fall through to a create (that would duplicate the person). `remove` is idempotent by contract.
- Consent is checked BEFORE the Admin API call, so a customer without consent has their PII fetched not at all (a test asserts the reader was never called). `customer.erased` deletes before anything is read and works with the customer row already gone.
- Admin API: a 404 is an answer (customer gone), 401/403 are RETRYABLE (an unseeded service principal is a deploy-order problem, not a permanent refusal), and no response body ever reaches an error message — it is the one payload here full of PII.
- Fixture traps: `payment` AND `refund` both require `idempotency_key` (NOT NULL); `order` needs `sales_channel_id` + both address jsonbs and has no `legal_entity_id`.
- `src/cdp/consent.ts` is service-wide, not CDP-only: #555 imports `gate`/`readCustomerFacts` from it. Lift it to `src/consent.ts` only after #564 merges — moving a file under review invites a conflict.
- **#554 16.2 (CDP) — BUILT and green, LOCAL COMMITS ONLY. Plan approved by the manager 2026-10-23; the live block was run with the machine he granted. Waiting on #562 merging before anything is pushed.**
  Delivered: `data/cdp/tracking-plan.json` + `data/cdp/README.md` (9 mapped topics, 29 unmapped with reasons, all 38 contract topics accounted for exactly once); `apps/engagement/src/cdp/` = `mapper.ts` (pure), `consent.ts` (the only DB-touching CDP file), `consumer.ts` (group `engagement.cdp`), `types.ts`, `adapter/{memory,rudderstack}.ts`; config + main wiring (`ENGAGEMENT_CDP_ENABLED` defaults to 0); package 0.2.0, README + CHANGELOG + CLAUDE.md updated.
  Test state: **166/166 with the broker up, on two consecutive full runs** (both live blocks self-cleaning: "deleted 30 topic(s)" cdp + "deleted 12 topic(s)" ops, each asserting none remains); 160 passed / 6 skipped with `KAFKA_BROKERS=127.0.0.1:19099`. Per file: mapper 25, consent 25, adapters 18, cdp consumer 16 (13 DB + 3 live), ops rules 16, transports 13, config 24, dlq-watch 8, rate-limit 7, ops consumer 15. Package lint + typecheck clean, prettier clean, check-ownership OK.
  Manager rulings applied: tenant client per event for the consent read + organization client for the marks; the conservative gate IS the Phase 4 rule (no identify/track without granted `marketing_email`, guests DROPPED) and **no `cdp_analytics` CONTRACT CHANGE is to be filed** — it is a legal question on the owner's lawyer list, written in `data/cdp/README.md` as a deliberate default pending that answer; ignoring the payload's `marketing_consent` in favour of the projection accepted and written in those words; the mapped topic set accepted.
  Commits: 32ec036 (tracking plan + its README), c832b73 (the CDP module), d77bb25 (merge main 7c41d82), 95b3873 (the three #562 review nits).
  **#562 review nits, all folded in here** (the manager accepted nit 1 as reasoned, not as worded): (1) the handlers do NOT write the mark — the SDK does it after a handler returns (consumer.ts:369), so the explicit call was a redundant second INSERT, and `ctx.markProcessed(tx)` has nothing to join when the side effect is an HTTP call; (2) `ENGAGEMENT_DLQ_GROUPS` defaults to `KNOWN_GROUPS` = every group this service runs, README says production lists every group ON THE BUS (other windows included); (3) the crash handler logs `error_class` only.
  Verified with the machine (granted, then released): **166/166 with the broker up**, ~53 s, both live blocks self-cleaning (cdp 30 topics, ops 12, each asserting none remains); 160/6 with it unreachable.
  STILL TO DO: push, open #554 PR, report number + head sha; then #555.

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
