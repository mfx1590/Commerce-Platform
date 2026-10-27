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
- **#599 (Phase 5 wave 1, group overrides vs the DLQ watch) — FIXED, PR #613** (code commit `53d8fd7`, head =
  the memory commit; branch `engagement/phase5` off main `f70f590`). The bug was mine, recorded at
  Integration 4: `--drain` passed `config.groups` to its consumers while the long-running path built them
  inline with no group id, and `dlq.groups` had started defaulting to `config.groups` — so an override
  without `--drain` consumed one group and watched another's DLQ. Fixed structurally: **`buildConsumers()` in
  `main.ts` is the only place a consumer is constructed**, called by both modes, differing only in
  `fromBeginning` and the drain's per-batch hook. Plus `resolveConfig` refuses an explicit
  `ENGAGEMENT_DLQ_GROUPS` that omits a running group (more is fine, fewer is refused), configuration
  refusals exit **2** (`ConfigRefusedError`, which `ConsentModeConfigError` extends), and the drain report
  says `ran` rather than a constant `enabled.ops`. `src/main.test.ts` states the invariant — every group a
  consumer RUNS is watched — over six configurations, with no broker and no database. Verified 441/441 with
  the broker up (21 files, 112 s) and 432/9 offline; package 0.6.1.
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
- **#576 (16.2a, CDP consent mode) MERGED 2026-10-24 = 6897960**, PR #585, after one queue refusal that was
  my own doing: #583 put `customer.erased` v2 on main, my fixture commit 38338ed had given the shared erasure
  fixture an `email_hash`, and the "v1 suppresses by customer_id alone" test then asserted v1 behaviour on a
  v2 payload. Fixed in `0561202` by making `envelopeFor` take an explicit `version` and adding
  `customerErasedV1` (version 1, no hash, validated against the FROZEN v1 schema), with `expect(e.version)`
  and the field's absence asserted BEFORE the suppression — see the gotcha below. Opus reviewed #585 as
  MERGE; its follow-up is #586.
- **#590 (#586's PR) was BLOCKED by the Opus review — one real defect, and it was mine twice over.** The
  unknown-store check was correct for a consumer and wrong for a boot: `main()` had already started the ops
  consumer, so the throw reached a handler that logged `error_class: "Error"` and set `process.exitCode = 1`
  — and nothing exited. A running consumer keeps the event loop alive, the SIGTERM handlers were never
  registered, and the service stayed up with a configuration it had refused, with the variable name thrown
  away. THE LESSON: "fails the boot" is a claim about the PROCESS. A throw proves nothing unless something
  exits, and only a child-process test can show it — `src/main.boot.test.ts` boots the real entry point and
  asserts the exit code, the crash line and that no `started` line appears; against the old code it hung.
  Fixed in one commit: the check moved ahead of every `start()` (one warmed `StoreCodes`, shared with the CDP
  consumer, `warm()` idempotent); `ConsentModeConfigError` added, and it is the ONE class whose message the
  crash line prints (built from env names and store codes only, pinned by a test); the line is written with
  `writeSync` and the process `exit(1)`s; startup unwinds what it started; a bare
  `ENGAGEMENT_CDP_CONSENT_MODE_` fails instead of being skipped; the "before the broker" test now uses a
  kafka seam that throws if touched, so the ORDER is asserted with or without a broker.
- **#586 (16.2b, override-key validation) MERGED 2026-10-24 = `a689f58`, PR #590** — the four points of the #585 review, all
  approved before building. Verified **409/409 with the broker up** (18 files, 116 s; live blocks
  self-cleaning: cdp 30 topics, crm 21, ops 12, each asserting none remains) and **400 passed / 9 skipped**
  offline, up from 385/9. `fga:seed` re-run inside the machine grant (store reused, model written, 11 tuples
  already present); machine returned. Package 0.5.1.
  - **The bug:** `config.ts` stored the override under the RAW env suffix and looked it up normalised, so
    `..._brand_a` parsed, validated and matched nothing — the store stayed on `analytics` while the config
    said `strict`. 0.5.0 was loud about a bad VALUE and silent about a bad KEY.
  - **New module `src/consent-mode.ts`** (ACCEPTED by the manager, keep the header note): `storeEnvKey`,
    `parseConsentMode`, `readConsentModeOverrides`, `assertConsentModeOverridesKnown`. It exists because
    `config.ts` imports all three consumers for `KNOWN_GROUPS`, so `cdp/consumer.ts` cannot import
    `config.ts` back — and a second copy of the normalisation inside the consumer is the very bug class.
    `config.ts` delegates and re-exports `storeEnvKey`, so its surface did not change.
  - Disagreeing spellings of one store throw at config time; agreeing ones are allowed. An override naming
    no store throws from `createCdpConsumer.start()` right after `warm()` (`StoreCodes.codes()` added), which
    is the first moment the store list exists. ACCEPTED limit, commented: with the CDP disabled there is no
    list and no boot to fail.
  - CLAUDE.md's e-mail rule now names THREE exceptions (CRM sync, support context — which reads and returns
    the address to the agent, that being the feature — and the Chatwoot webhook hashing on arrival); the
    prohibitions are stated separately. The erasure wording in `data/cdp/README.md` and `cdp/consumer.ts` was
    wrong in two places: the core KEEPS the row with `status = 'erased'`, personal fields already replaced
    (checked in `apps/core/src/modules/customers/admin.ts`), so the hash is unrecoverable because the ADDRESS
    is gone. #584 cited with its decision.
  - The 404-equivalence test compared two identical `() => null` fakes; the second reader is now store-aware
    (owns brand-B's customer, answers null under brand-a) with an assertion that it DOES find them under
    their own store.
- **#583 (customer.erased v2 integration) UNBLOCKED 2026-10-24** — side task, done and out of the way. `makeEvent` started writing v2, so 12 engagement tests built `customer.erased` without the now-required `email_hash`. One commit, **38338ed**, on branch `integration/customer-erased-v2-fixtures` (pushed; the manager fast-forwarded `integration/customer-erased-v2` to it and re-ran CI): one line per fixture in cdp/mapper.test.ts, cdp/consumer.test.ts, crm/consumer.test.ts, plus `data/cdp/tracking-plan.json`'s `customer.erased` version note (said 1, `makeEvent` emits 2). No production code. The CRM file uses its own `'f'.repeat(64)` convention rather than `createHash` — runtime, no committed literal; accepted.
- **#556 16.4 (support context + Chatwoot webhook) — BUILT and VERIFIED: 326/326 with the broker up (~85 s, three live blocks self-cleaning: cdp 30 topics, crm 21, ops 12); 317/9 offline. Committed LOCALLY as 70f1118 + 92cdf74.** That is all four issues built.
  **PR BLOCKED ON TWO QUEUED MERGES, in this order: #568 (in the merge queue), then #570** — the integration PR for CONTRACT CHANGE #569. #556's code really does call the new parameter (`src/support/admin-api.ts:135`, `?customer_id=`) and it is NOT on origin/main yet, so the PR waits. The manager says when.
  **Caveat recorded for Integration 4:** the support tests drive a FAKE reader, so they prove the gate order, the header forwarding, the normalisation and the notes — NOT that the core honours `customer_id`. The first genuine proof is a live call once #570 and window 1's predicate are both in; that spans two windows, so it belongs on the integration list rather than in my PR.
  Both approved by the manager and DONE locally (2026-10-23), to ride in #556's PR:
  - **ede629f** — `support/admin-api.test.ts` (17 tests) pins the request shape to the contract: the exact paths, `customer_id` with sort/order/limit, the id encoded so it cannot smuggle a second parameter, and NO e-mail and no `q` in the query string (the whole reason #569 exists). Also the first direct cover of the reader's answer mapping: 404 → null/[], 401/403 passed through unchanged (the core refused the AGENT), everything else a 502 carrying neither body nor URL nor token.
  - **7af93c7** — `src/cdp/consent.ts` lifted to `src/consent.ts` with its test, as its own commit, no behaviour change. Both consumers now import one rule from one place. The one real change: the gate's identity type is declared there as `GateIdentity` instead of imported from `cdp/types.ts` — a service-wide module must not depend on one consumer's types, and the two are structurally identical so nothing converts or casts.
  State: **334 passed / 9 skipped offline** (343 total; was 326 before the 17 new tests). Lint, typecheck, ownership, prettier clean.
  **RE-RUN LIVE after those two commits (machine granted, then released): 343/343, 18 files, ~81 s**, all three live blocks self-cleaning (cdp 30 topics, crm 21, ops 12), each asserting none remains. So the current verified figure is 343/343 with the broker up and 334/9 offline; the earlier 326/326 is superseded and refers to the state before ede629f and 7af93c7.
  Delivered: `src/support/` = `auth.ts` (the two gates), `admin-api.ts` (three reads, each with the AGENT's header), `context.ts` (pure normalisation + summary), `chatwoot.ts` (HMAC + freshness + seen-once), `server.ts` (node:http, three routes), `types.ts`; config + main wiring (`ENGAGEMENT_SUPPORT_ENABLED` defaults 0); `@platform/auth-sdk` added as a dependency; package 0.4.0; README + CHANGELOG + CLAUDE.md.
  **CONTRACT CHANGE #569 ACCEPTED** (listOrders `customer_id`, Admin API 0.4.24, landed on integration/orders-customer-filter a2e6e98; window 1 adds the core predicate). Built against it.
  **#568 = Fable MERGE**; its three nits folded in here (see below).

### #576 — approved plan (CDP consent mode), with the manager's rulings

**The owner reversed #554's conservative gate on 2026-10-23: TRACK.** Analytics tracking without marketing consent, and guests under `email_hash`, as the DEFAULT everywhere. Region rules come later as config, not code.

- `ENGAGEMENT_CDP_CONSENT_MODE` = `analytics` (DEFAULT) | `strict`, resolved **PER STORE**: `ENGAGEMENT_CDP_CONSENT_MODE_<STORE_CODE>` overrides the global default (`brand-a` → `BRAND_A`, the `NOTIFICATIONS_<STORE>_<FIELD>` pattern). An unknown mode value THROWS at config time, never a silent fallback. Each brand is one market (A=EU, B=UK, C=US), so per store = per region.
- Resolve the mode **per event** from the store code the consumer already looks up, and put `consent_mode` on the per-event log line (no PII).
- `analytics`: `track` and `identify` run without `marketing_email`; a guest (no `customer_id`) is tracked with `anonymousId = email_hash`, dropped only when there is no hash either. `strict`: exactly #554's gate.
- **Identify carries EXACTLY `customer_id`, `email_hash`, store code — in BOTH modes.** `status` and `customer_group_id` are DROPPED (manager ruling: ids only, never a marketing trait; `customer_group_id` is a marketing segment id). `data/cdp/tracking-plan.json`'s trait list must be updated to match, or the mapper/plan agreement test fails.
- Unchanged in both: `customer.erased` ungated; CDP off unless `ENGAGEMENT_CDP_ENABLED=1`; no PII leaves; **CRM sync (#555) is NOT affected and stays consent-gated** — add a test asserting the CRM gate ignores the CDP mode, so the two cannot drift.
- Tests: both modes × consented / unconsented / guest; erase in both; **a store override beating the global default**; the PII sweep unchanged; the CRM-unaffected test.
- `data/cdp/README.md`: replace the lawyer-pending section with the owner's decision of 2026-10-23, a modes table, the one-line switch to make a region strict, and BOTH erasure gaps below.

**The erasure gap I found, and #580.** #576 says erasure suppresses "customer_id AND email_hash", but `customer.erased` v1 carries NO hash and the row is deleted by then. That matters now precisely because `analytics` creates hash-keyed guest profiles, so an erasure could suppress the `customer_id` profile and leave the same person's earlier hash-keyed one. **CONTRACT CHANGE #580 ACCEPTED** — `customer.erased` v2 adds `email_hash` (house `sha256` $def, required); the events side has LANDED on `integration/customer-erased-v2` (d55a998, events 0.6.2) and window 13 writes the producer tomorrow. **Build suppression to send `customer_id` and `email_hash` WHEN PRESENT**, so v2 works the day it lands and v1 keeps working.
**Second gap, record as a known limit:** a guest who never registers produces no `customer.erased` at all, so their hash-keyed profile has nothing to trigger a suppression. Needs a guest-erasure path keyed by e-mail — a later wave.

**Also fold in the #573 nit:** the `context.ts` comment claiming a core 403 "becomes" a 404 is WRONG (the reader passes 401/403 through deliberately; a foreign customer yields 404 because RLS hides them). Manager ruling: fix the comment, rename the test to what it proves, **add NO 403→404 mapping** — masking a gate/core disagreement would be worse.

### #573 BLOCK — three real fixes, worth not repeating
- **The support reader did not match the contract.** It read `body.orders` where `listOrders` answers a `Page` of `items`, and treated `total` as a scalar where `OrderSummary.total` is `Money { amount_minor, currency }` (the ONLY place a summary carries a currency). Against the real core: zero orders, empty currency. **No test could catch it because they all drove a hand-written fake.** LESSON: when a reader talks to a contract, type its responses FROM the contract (`@platform/contracts/admin`) and type every fixture from the contract's schemas — then drift is a compile error. Typing the existing fixtures surfaced six more wrong fields. `getCustomer` and `getOrder` return their schema DIRECTLY (no envelope).
- **Validate path ids as uuids in the route BEFORE any call** → 404 (not 400: malformed and absent must look the same), and `encodeURIComponent` every path segment in the reader. `%2F..%2F` decodes to `/../`, and an unvalidated id in a path could reach another Admin API route WITH THE AGENT'S OWN TOKEN.
- **`sha256(secret + '.' + body)` is NOT an HMAC** — a keyed hash, no inner/outer padding, the length-extension construction. Use `createHmac('sha256', secret)`. Chatwoot's documented header format could not be confirmed by search, so both bare-hex and `sha256=` are accepted and the README says it is UNVERIFIED (launch-checklist check). Do not claim a compatibility nobody verified.
- Test nits worth keeping as habits: a permission fake must record WHAT IT WAS ASKED (a flat boolean would pass a `store:*` check); two different upstream answers that must look identical should be asserted byte-identical, not just same-status.
- Known limit recorded, not fixed: the store lookup precedes the permission check, so store codes are enumerable by authenticated staff (404 vs 403).

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

## RESUME HERE — 2026-10-25: Phase 5 wave 1 (#599) FIXED, PR open

**Manager session NINE is the manager now** (session eight stood down). Phase 5 started: plan
`docs/plan/phase5-plan.md`, tracking **#612**. My wave-1 task was **#599** and it is done on branch
`engagement/phase5` (cut from main `f70f590`). **Wave 3 (after the weekly reset) is #610 — support reply
drafts, default OFF. Nothing to do for it yet.**

**PR #613 (code commit `53d8fd7`; head = this memory commit).** The #613 review was a BLOCK on the record
only — the code read as mergeable — for exactly this line being absent. Its other four points are fixed in
the same push: every `resolveConfig` refusal is now a `ConfigRefusedError` (so the exit-2 claim matches the
code, 16 of them), the stale `exit(1)` paragraph in `apps/engagement/CLAUDE.md` is rewritten, and the
`started` / `stopped` log lines print the RESOLVED group id instead of the module constant — the same drift
as #599, one level down, in `ops/cdp/crm consumer.ts`. Item 5 (a test that `main()` calls `buildConsumers`)
is a follow-up by the manager's decision, not in this PR.

**#599, the bug I recorded at Integration 4 and then fixed.** The drain passed `config.groups` to its
consumers; the long-running path built them inline with no group id, while `dlq.groups` had started
defaulting to `config.groups`. So an override without `--drain` consumed one group and watched another's
DLQ. **The fix is structural: `buildConsumers` in `main.ts` is now the only place a consumer is constructed**
and therefore the only place a group is chosen; both modes call it and may differ only in `fromBeginning`
and the drain's per-batch hook. Chosen over "refuse the overrides unless `--drain`" because the override is
about WHICH group, never about which path read it — and window 12's #600 copies this pattern. Plus:
`resolveConfig` refuses an explicit `ENGAGEMENT_DLQ_GROUPS` that omits a running group (more is fine, fewer
is refused), and **a configuration refusal now exits 2** (`ConfigRefusedError`, which `ConsentModeConfigError`
extends) so a supervisor does not restart an environment already refused.

**Verified:** 441/441 with the broker up (21 files, 112 s, live blocks self-cleaning: cdp 30 / crm 21 / ops
12) before the review fixes, and **445 passed / 9 skipped offline** after them; typecheck, lint, prettier,
ownership clean. Package 0.6.1. Machine granted and returned.

**`src/main.test.ts` is the new pattern to copy:** it states the invariant — every group a consumer RUNS is a
group the watch WATCHES — over six configurations including the broken one, with no broker and no database,
because constructing a consumer connects to nothing. A test that reads a shipped object's `groupId` is worth
more than one that re-derives what the code should have done.

**The lesson, now twice over:** when one path gains a defaulted value, check every OTHER path that reads it.

<!-- The Integration 4 / Phase 4 record below still holds; its operational notes are still accurate. -->

## Integration 4 and Phase 4 (closed 2026-10-25)

**#598 MERGED = `b2a967a`** (Integration 4 step 3; Opus review = MERGE). **#594 closed, Phase 4 closed**,
tags `contracts-v0.4.28` and `events-v1.1`. Window 16 is idle; the manager writes if anything comes up.

**#599 IS FILED FOR ME AND IS A REAL BUG I INTRODUCED — do NOT start it until a manager session assigns
it.** From the #598 review: in `src/main.ts`'s LONG-RUNNING path, `config.groups` is passed to the drain's
consumers but NOT to the long-running ones, while `dlq.groups` now DEFAULTS to `config.groups`. So
`ENGAGEMENT_*_GROUP_ID` set WITHOUT `--drain` makes the process consume `engagement.cdp` while watching
`dlq.engagement.cdp.int4` — an all-clear about a queue nobody fills, which is the exact failure mode I wrote
the rule about and then built into the other path. Preferred fix per the issue: **refuse the group overrides
unless `--drain` is given**; the alternative is wiring them through the long-running path consistently. Test
both ways. Nits with it: the co-author trailer, and state in the drain report that ops is ALWAYS enabled
(the report prints `enabled: { ops: true, … }` as a constant, which reads like a resolved value).

**The lesson, written down because it is the second time a report of mine was righter than the code:** when
one path gains a defaulted value, check every OTHER path that reads it. The drain and the long-running mode
share `resolveConfig`, so a default added for one silently changed the other.

<!-- The step-3 detail below stays: it is the record of what ran and the operational traps. -->

## Integration 4 step 3 — what ran (2026-10-25)

**#594 step 3 (engagement on the dev bus) ran GREEN on branch `engagement/int4`** (cut from main `5cbe10b`).
Built for it: `--drain` (one-shot measurement mode), per-module group overrides, `src/drain.ts`
(`summariseDrain` + `waitForIdle`), `StoreCodes.codes()` shared with the entry point, and
`ENGAGEMENT_CRM_MOCK_TOKEN` — the manager-approved DEV STAND-IN for the #565 principal, never in production.
Package 0.6.0, 423 passed / 9 live skipped offline.

**The numbers (one run, machine granted and returned):** CDP 152 handled / 148 sent / 4 dropped; CRM 149
handled / 20 upserted / 129 skipped; OPS 0 events; **0 dead letters in all three fresh groups**
(`engagement.{ops,cdp,crm}.int4`); PII sweep 0 hits over the 152 CDP calls, the dev sink and all 312 log
lines. Live support context: 200 with 18 orders through `listOrders?customer_id=` against the real core, and
a brand-B customer under brand-a = 404 — **#569's Integration 4 item is closed**, so the "a fake reader
cannot prove the core honours the filter" caveat from #556 is answered.

**Three findings worth keeping:**
1. **The dev data cannot exercise ops at all** — no `payment.failed` / `refund.failed` / `return.requested`
   has ever been produced on the dev stack. Reported as a coverage gap, not a pass.
2. **#584's guest-lifecycle asymmetry showed up on real data**: all 4 CDP drops were `no_identity` on
   `order.cancelled` / `shipment.shipped`, whose payloads carry neither id, while 126 guest `order.placed`
   events were tracked under their `email_hash`.
3. **The report caught its own bug**: a dropped CDP line still carries the `call` the mapper produced, so
   counting every line read 149 tracks against 148 sends. Fixed (sent only) with a test. Keeping BOTH the
   log-derived report and the consumers' own counters is what made it visible.

**Operational notes for the next live run:** the engagement process does NOT load the root `.env`, so
`OPENFGA_*` and `KEYCLOAK_*` must be passed explicitly or the support gate answers 503 (fail closed, which I
saw). Pin `DATABASE_URL_APP` and `KAFKA_BROKERS` to 127.0.0.1 — but **leave `KEYCLOAK_URL` on `localhost`**:
the verifier pins the issuer, and a 127.0.0.1 host turns a valid token into 401. The core must run with
`CORE_DEV_TOKENS=1` for the CRM stand-in token, and it outlives its wrapper — stop it by port.

<!-- The 2026-10-24 end-of-phase block below still describes the four Phase 4 tasks. -->

## RESUME (superseded) — 2026-10-24: PHASE 4 COMPLETE, WINDOW 16 IDLE

**All six issues merged:** #553 (via #563), #554 (#564), #555 (#568), #556 (#573), #576 (#585 = `6897960`)
and **#586 (#590 = `a689f58`)**. The manager confirmed the list is closed and told this window to go idle; he
writes if anything comes up. Branch `engagement/phase4` is merged into main and matches it (`a689f58`).

**#590's first CI red was NOT this service:** a cross-package race in `createTestDatabase` (migration 0001's
role check-then-create), fixed by the manager as **#593** (packages/db 0.3.18, queued). Worth knowing before
blaming anything of mine for a flaky DB test in another window's run.

**If a new task arrives, start here:** read this file's Done section for what each module is and why, then
`apps/engagement/CLAUDE.md` for the rules that must not be re-derived (the e-mail rule with its three
exceptions, the consent-mode rules, post-then-mark, the two clients, the boot rule from #590). Ask the
manager for the machine before any live or full suite; re-run `pnpm --filter @platform/auth-sdk fga:seed`
inside the grant if Docker has restarted since.

**Not mine to start** (recorded, unassigned): the three #590 nits above; **#584** (`email_hash` on the five
order-scoped topics — the only way to close the guest-lifecycle asymmetry, since reading a raw address was
refused); `customer.erased` v2 producer (window 13); a guest-erasure path keyed by e-mail; an Integration-4
live `customer_id` call against the core (the support tests drive a fake reader and cannot prove the core
honours the filter); and the launch-checklist items — a real Slack workspace, a RudderStack account, a Twenty
instance, a real Chatwoot delivery to confirm its header format, and the `crm-sync` service account (#565).

**Verified state at the end:** 414/414 with the broker up (19 files, 127 s; live blocks self-cleaning: cdp 30
topics, crm 21, ops 12), 405 passed / 9 skipped offline. Package 0.5.1.

<!-- The earlier RESUME blocks below are kept for the record; everything in them is done. -->

## RESUME (superseded) — #586 pushed, waiting on its review

**#576 merged (`6897960`); #586 is BUILT, verified 409/409 live, and its PR is open** (see Done above for the
whole shape of it). Branch `engagement/phase4`. The machine was granted, used for `fga:seed` + the full run,
and returned with the numbers reported.

**When #586's review comes back:** read the review COMMENT itself, never a summary — on #568, #573 and #585 a
"nit" was a real bug each time (a wrong contract shape, a keyed hash that was not an HMAC, a test asserting
the right thing for the wrong reason). Fold the fixes in, re-run offline, ask for the machine before any live
run, and push only on the manager's word.

**Nothing else is assigned.** The later-wave items that exist but are NOT mine to start: `customer.erased` v2
producer (window 13), a guest-erasure path keyed by e-mail with no customer behind it, **#584** (`email_hash`
on the five order-scoped topics — the only way to close the guest-lifecycle asymmetry, since reading a raw
address was refused), an Integration-4 live `customer_id` call against the core (the support tests drive a
fake reader and cannot prove the core honours the filter), and the launch-checklist items: a real Slack
workspace, a RudderStack account, a Twenty instance, a real Chatwoot delivery to confirm its header format,
and the `crm-sync` service-account token (#565).

<!-- The 2026-10-24 #585/#586 block below is kept for the record; both are done. -->

## RESUME (superseded) — #585 fixed and pushed, #586 next

**#585 (#576, CDP consent mode) was REFUSED by the merge queue** once #583 landed `customer.erased` v2 on
main (738c34a). Real failure, not a flake: `cdp/consumer.test.ts`'s "suppresses by `customer_id` alone on a
v1 payload" reused the shared erasure fixture, which my own #583 commit (38338ed) gave an `email_hash`, so
the v1 assertion ran on a v2 payload and got the hash where it expected `null`. (The first red, a storefront
perf-store-example timeout, WAS a flake and was gone on the rerun.) Fixed by building a genuine v1 envelope
— `envelopeFor` now takes an explicit `version`, the fixture omits `email_hash`, and the test asserts
`version === 1` and the field's absence before asserting the suppression. Offline suite re-run: **385 passed
/ 9 live skipped**, 18 files, ~51 s; typecheck, lint, prettier, ownership clean.

**#586 (16.2b) is next and the plan is APPROVED** — build it only after the manager confirms #585 merged:
1. `config.ts:303` stores the RAW env suffix in the overrides map while `consentModeFor` looks up
   `storeEnvKey(code)`, so `..._brand_a` or `..._BRANDA` is parsed, validated and then never matched: the
   store silently stays on `analytics`. Normalise the key the same way as the lookup; **throw** when two keys
   normalise to the same code with DIFFERENT values (identical ones are fine); add `codes()` to
   `src/ops/store-codes.ts`, expose the normalised override keys on `config.cdp`, and validate them in
   `createCdpConsumer.start()` right after `warm()`, throwing with the unknown keys and the known codes.
   ACCEPTED limit, to be commented: the CDP ships off, so with `ENGAGEMENT_CDP_ENABLED=0` there is no store
   list and no boot to fail — `resolveConfig` must not reach a database.
2. `apps/engagement/CLAUDE.md`'s "no raw e-mail reads" rule must name BOTH real exceptions: the #556 support
   path reads and returns the address to the agent, and the Chatwoot receiver hashes one on arrival. (The
   manager confirmed the edit is in scope — my package, a factual fix that loosens nothing — and told the
   owner; the owner was told here too.)
3. `data/cdp/README.md` gap 1 and the `cdp/consumer.ts` comment wrongly say the core DELETES the customer
   row; it keeps it with `status = 'erased'`. Correct both and cite **#584** in the guest-lifecycle section.
4. `support/server.test.ts`'s renamed 404-equivalence test builds two IDENTICAL `getCustomer: async () =>
   null` fakes, so it proves determinism only. Make the second fake hold a brand-b customer and return null
   for a brand-a read, so it exercises the invisible row.
Tests to add: lowercase key honoured, typo key fails, override naming no known store fails after warm,
colliding keys that disagree fail, consumer start both ways. ~30 tool calls, size approved.

**Before the next live run:** re-seed FGA (see Blocked / waiting) and ask for the machine.

<!-- The block below is from 2026-10-23 and is kept for the #556/#573 record; its "tomorrow" steps are done. -->


**ALL FOUR ISSUES ARE DELIVERED.** #553 merged (via #563), #554 merged (#564), #555 merged (#568 = 9d8915a), #556 is **PR #573 — Fable MERGE after a re-review, in the merge queue**; the manager confirms tomorrow. Window 16's Phase 4 scope is complete.

**TOMORROW, in this order, and only on the manager's word:**
1. He confirms **#573 merged**. Then merge main, `pnpm install --frozen-lockfile`, rebuild the workspace packages.
2. Build **#576 (16.2a, CDP consent mode)** — plan APPROVED, see "#576 — approved plan" below. Local commits only until he says push.
3. Ask for the machine before any live block (one window measures at a time). The support tests need no broker; the three consumer live blocks do.

**State:** branch `engagement/phase4` pushed at **c06a9a9** = PR #573. Verified 343/343 with the broker up (18 files, ~81 s) before the main merge, and **334/9 offline re-run AFTER merging main** (e6c73e0, which brought db migration 0203 — every DB test applies the full set, so the re-run was warranted). Lint, typecheck, ownership, prettier clean.

**#570 MERGED = e6c73e0**: `customer_id` is on main's Admin API 0.4.24 (verified in packages/contracts/openapi/admin-api.yaml, with window 1's core predicate in 0e466dc). The blocker is gone.

**If review nits come back:** fold them in, re-run offline, ask the manager for the machine before any live run, and do NOT push until he confirms. Old steps, kept in case a new branch is ever needed:
1. `git fetch origin main && git merge origin/main --no-edit`
2. `pnpm install --frozen-lockfile && pnpm build --filter "./packages/*"`
3. Re-run the suite ONLY if that merge touched `apps/engagement/**`, `packages/events`, `packages/db` or `packages/auth-sdk` — and ask the manager for the machine first if the live blocks are needed (ONE WINDOW MEASURES AT A TIME). Otherwise the 343/343 above stands.
4. `bash scripts/check-ownership.sh`, then push, then `gh pr create` with `Closes #556` on exactly ONE line (grep the body before opening — that is a standing manager rule).
5. Message the manager the PR number + head sha, then HOLD all pushes.

**What #556's PR body must contain** (all of it is already in apps/engagement/README.md, so draft from there):
- the acceptance criteria ticked: routes + tests (401, 403 for a non-support role and for another store, 200), the webhook stub (HMAC, bad signature 401, replay-safe), README "Support", CHANGELOG, memory;
- the verification table: 343/343 broker up, 334/9 offline, the three live blocks' topic counts and the cleanup assertion, lint/typecheck/ownership/prettier, and that the machine was granted and released;
- the decisions, each with its reason: the AGENT's own token rather than a service principal; the gate order (authenticate → store → `support` on that store → read) so 401 lands before a parameter is parsed; **503 not 403** when OpenFGA is unreachable; a customer of another store getting the **same 404** as a non-existent one; nothing cached and `cache-control: no-store`; a partial answer visible in `notes` while a 401/403 is re-thrown;
- the webhook's **documented limit** (no agent token, no service principal by ruling, no link table — so 202 with `persisted: false`, resolution happens on the dashboard request) and its replay guards' limits (freshness window, no-timestamp rejected, in-memory seen-once LRU);
- the two extra commits: `ede629f` (pins `customer_id` to the contract, and that no e-mail or `q` reaches the query string) and `7af93c7` (`consent.ts` lifted to the top level, **no behaviour change**, `GateIdentity` declared there so a service-wide module does not depend on one consumer's types) — the manager asked for the no-behaviour-change wording in the body;
- **launch-checklist items:** a real Chatwoot instance (the HMAC/freshness/replay guards are tested against generated signatures only), and a persisting conversation→customer link plus the principal a webhook would need;
- **Integration 4 item:** a live `customer_id` call against the core. The support tests drive a FAKE reader, so they prove the gate order, header forwarding, normalisation and notes — NOT that the core honours the filter. Do not claim otherwise.

**Window 16 is otherwise done:** #553 merged (via #563), #554 merged (via #564), #555 is PR #568 (Fable MERGE, in the queue), #556 ready. Contract changes #565 and #569 both filed and accepted. The service owns no table.

## Next — Phase 4 (issues, in order)
- [x] #553 16.1 apps/engagement service + ops alerts (group `engagement.ops`) — PR #562, via #563
- [x] #554 16.2 CDP tracking plan + RudderStack mapper (group `engagement.cdp`) — PR #564
- [x] #555 16.3 CRM sync, Twenty adapter (group `engagement.crm`) — PR #568; #565 accepted
- [x] #556 16.4 Support context API + Chatwoot webhook stub — PR #573; #569 accepted
- [x] #576 16.2a CDP consent mode (`analytics` default, per-store `strict`) — PR #585 = `6897960`
- [x] #586 16.2b override keys normalised + the boot actually fails — PR #590 = `a689f58`
- Side task: #583's fixture unblock (`38338ed`); contract changes #565, #569, #580 accepted, #584 filed

## Decisions made (with reasons)
- 2026-10-23 (manager, kickoff — full text on #553): apps/notifications stays with window 17 (it built transactional email there since #360); your row is apps/engagement, apps/support, data/cdp. One new service apps/engagement; the manager lands its Dockerfile manifest lines as an integration commit on your 16.1 head. Shared `consumer_processed` (db 0202) via the SDK's pg store. SMS/WhatsApp (Twilio), Novu, Klaviyo flows DEFERRED until accounts exist; returns portal + refund limits by role are a later wave (core/auth/storefront/admin), not yours.

## Blocked / waiting
- **#590's three recorded nits — NOT assigned, do them only if told** (Opus MERGE on `cc90ca3`, manager
  2026-10-24; `6190146` verified 414/414 live and recorded on the PR, so no doc commit was pushed):
  1. `StoreCodes.warm()` is idempotent but does not cache the IN-FLIGHT promise, so two concurrent first
     calls still both query. Hold the promise, not just the `warmed` flag.
  2. `parseConsentMode`'s bad-value message echoes the raw value (`got "strcit"`). That matters more than it
     looks NOW, because the crash line prints this class's message: whatever someone put in the variable is
     printed. Echo the variable name and the allowed values, not the input.
  3. `main()`'s `stop()` stops the consumers before closing the HTTP server. The server should close FIRST —
     stop accepting support requests, then drain the consumers.
- **Before the NEXT live run: re-run `pnpm --filter @platform/auth-sdk fga:seed` in this worktree.** Docker had stopped and was restarted on 2026-10-24 (manager; compose start, nothing recreated, DB intact). Not run yet, deliberately: the seed writes SHARED OpenFGA state and rewrites this worktree's `.env` fga ids, so it belongs inside the machine grant, together with the live run — not while another window may be measuring.
- **The machine for the live broker block** (one window measures at a time; window 15 also active). Asked the manager 2026-10-23: 3 tests, prefixed `t-eng-<random>.` topics, self-cleaning, ~60-90 s. Note `pnpm test --filter @platform/engagement` AT ROOT runs the live block too whenever the broker is up — so that root command is itself the live run, not a safe pre-check.
- ~~db 0202~~ **RESOLVED 2026-10-23: #557 merged** (main 653d817, packages/db 0.3.16); the landed file is byte-identical to the one I built against, so the copy and `applyProposedMigration` are deleted (1e1a9d8) and `createTestDatabase` applies the real migration. Its shape, asserted in my tests from the consumer's side: RLS `organization_only` (a store-scoped client reads nothing and cannot insert → the consumer MUST use createOrganizationClient), `organization_id` DEFAULT app.current_organization_id() (the SDK's two-column INSERT works), PK (group_id, outbox_id), UPDATE revoked from platform_app, group_id CHECK `^[a-z][a-z0-9_.-]*$` (so `engagement.ops` is fine).
- ~~.gitignore row for `.engagement/`~~ **RESOLVED: on main in 653d817** (the manager added it; he also chose the name and `ENGAGEMENT_DIR`).
- External accounts (Slack webhook, RudderStack, Twenty/HubSpot, Chatwoot): mocks until the owner provides them; live use on the launch checklist.

## Gotchas learned
- **A shared fixture and a version-pinned test are a trap.** Bumping the shared `customer.erased` fixture to v2 (#583) silently turned the "v1 carries no hash" test into a v2 test that asserted the wrong thing — and it only went red when #583 reached main, i.e. in the MERGE QUEUE, not on my branch. A test that is about one schema version must build its own envelope with an explicit `version` and assert that version, because `makeEvent` always stamps `LATEST_VERSION`. The same applies to any frozen-version path (stock.moved v1, customer.export_requested v1).
- **A window-prefixed branch cut from an INTEGRATION branch always fails the ownership job.** `scripts/check-ownership.sh` diffs `merge-base(main, HEAD)...HEAD`, so it judges the integration branch's OWN commits under your prefix too. Cutting `engagement/phase4-580-fixtures` from `integration/customer-erased-v2` was flagged for `packages/events/test/registry.test.ts` — the manager's own events landing, a file not in my diff. Name such a branch `integration/…` (it may write anywhere, and the prefix is honest: it IS the integration branch plus a commit). Accepted by the manager 2026-10-24.
- (from Memory-main, read its Global gotchas) loopback 127.0.0.1 for DB and broker; rebuild workspace packages after every merge of main (stale dist); a new workspace package breaks `app images` until every Dockerfile COPYs its manifest — the manager lands mine, I never touch a Dockerfile.
- The `app images` manifest rule bit nobody yet because I did not add the COPY lines; do not "help" by editing infra.
- gitleaks: I nearly committed a real 40-hex sha1 as an email_hash fixture. Replaced with `emailhash-of-ada-not-hex`. Any long hex literal in a test is a repo-wide CI outage waiting to happen.

## How to run & test this package
- Worktree setup, every session: `pnpm install --frozen-lockfile` → `pnpm build --filter "./packages/*"` → `pnpm --filter @platform/auth-sdk fga:seed` (memory datastore: re-seed after an OpenFGA restart).
- apps/engagement: `pnpm --filter @platform/engagement dev` (consumer + DLQ poll) / `once` (one DLQ poll, exits).
- Tests: `pnpm --filter @platform/engagement exec vitest run` — add `KAFKA_BROKERS=127.0.0.1:19099` to run everything EXCEPT the live block (68 pass, 3 skip) without taking the machine.
- Before finishing a task: `pnpm lint && pnpm typecheck && pnpm test --filter @platform/engagement` (the last one needs the machine) and `bash scripts/check-ownership.sh`.
