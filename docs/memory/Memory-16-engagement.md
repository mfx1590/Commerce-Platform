# Memory 16 — CRM, CDP, ops alerts & support
Window: 16 · Key: `engagement` · Branch prefix: `engagement/` · Model: Sonnet
Last updated: 2026-10-23 (window 16, session one) · Contracts: contracts-v0.4.26, events-v1 = 2abe310 · Last commit: (see In progress) · Status: 16.1 COMPLETE and verified — 71/71 on three consecutive full runs with the broker up; machine released; pushing + opening the PR next

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
- (nothing merged yet)

## In progress
- **#553 16.1 apps/engagement + ops alerts — BUILT, plan approved by the manager 2026-10-23. Blocked only on the machine for the live broker block (asked 2026-10-23), then merge main → push → PR.**
  Delivered in apps/engagement (26 files): package `@platform/engagement` 0.1.0 (index.ts public API, README, CLAUDE.md, CHANGELOG, tsconfig + tsconfig.test + vitest.config), `src/ops/{rules,consumer,rate-limit,dlq-watch,store-codes}.ts`, `src/transport/{types,dev-sink,slack}.ts`, `src/{config,main,types,index}.ts`, and `migrations/0202_consumer_processed.sql` (the COPY, see Blocked).
  Test state: **68 passed, 3 skipped** with the broker deliberately offline (`KAFKA_BROKERS=127.0.0.1:19099`), which also proved the skip-with-a-printed-reason path. Per file: rules 16, transports 13, config 12, dlq-watch 8, rate-limit 7, consumer 15 (12 DB + 3 live skipped). Root `pnpm lint` and `pnpm typecheck` (24 tasks) green; `bash scripts/check-ownership.sh` → OK (engagement/phase4); prettier clean.
  Commits: 065d0a3 (the service + ops alerts), fe9f910 (merge main 653d817), 1e1a9d8 (drop the 0202 copy — #557 landed). After the merge: `pnpm install --frozen-lockfile`, packages rebuilt, 68 pass / 3 live skip, lint + typecheck green.
  LIVE RUN DONE 2026-10-23 (machine granted, then released): **71/71 on three consecutive full-suite runs**, ~26 s each, cleanup asserted ("deleted 12 topic(s) with prefix t-eng-<random>" + afterAll assertion that none remains). Manager rulings received: post-then-mark ACCEPTED, return.requested.reason excluded / PSP failure_reason included ACCEPTED, both to stay asserted.
  STILL TO DO: (1) push engagement/phase4, open the PR (acceptance criteria, live counts + duration, exactly one `Closes #553` line); (2) message the manager the number + head sha, then HOLD ALL PUSHES — he cuts `integration/engagement-service` from my head, adds the Dockerfile COPY lines, and THAT integration PR is the one that merges; (3) expect `app images` red on my PR until his commit; (4) message him again when every check finished.

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

## Next — Phase 4 (issues, in order)
- [ ] #553 16.1 apps/engagement service + ops alerts (group `engagement.ops`) — the window-wide decisions are on this issue
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
