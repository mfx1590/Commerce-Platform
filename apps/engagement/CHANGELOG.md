# @platform/engagement

## 0.2.0 — 2026-10-23 (#554, task 16.2)

The CDP: a tracking plan, a pure mapper, a consent gate and two adapters.

- **`data/cdp/tracking-plan.json`** (+ its README): the contract between the bus and the CDP. 9 topics mapped
  (`customer.created` / `customer.updated` to `identify`, `customer.erased` to `suppress`, and `order.placed`,
  `order.cancelled`, `payment.captured`, `refund.issued`, `shipment.shipped`, `return.requested` to `track`)
  and 29 listed as unmapped **with reasons**. A test asserts the plan and `src/cdp/mapper.ts` agree in both
  directions and that the two lists cover every topic in the events contract exactly once — so a new event
  cannot be silently forgotten or silently sent.
- **Consumer group `engagement.cdp`** on the events-v1 SDK, marks in the shared `consumer_processed`, and the
  same post-then-mark trade as the ops consumer (a redelivery sends nothing; a crash in the gap can repeat one
  call, which the CDP can de-duplicate on `messageId` = the outbox id).
- **Consent gate** (manager ruling 2026-10-23): read-only, from the `customer.consent` **projection**, through
  a **store-scoped** client for the event's own store, **evaluated at processing time**. Never the
  `customer_consent` ledger rows, never a write, never an API hop. The `marketing_consent` field in the
  `customer.created` / `customer.updated` payloads is deliberately **ignored**, so a decision can contradict
  the event's own snapshot — asserted by a test that the two events yield identical traits either way.
  `customer.erased` is the only ungated call and still suppresses when the customer row is already gone.
  A guest (no `customer_id`) is **dropped**, not tracked pseudonymously: the conservative default while the
  consent-for-analytics question sits on the owner's lawyer list.
- **Two database clients, structurally**: the organization one for the marks (`consumer_processed` is RLS kind
  `organization_only`, so a store-scoped client can neither read nor write it), and a store-scoped one per
  event for the consent read. An organization client could do both; the second is least privilege by choice,
  because consent is never propagated across stores (0194).
- **Identity**: `customer_id` else `email_hash`. The five order-scoped topics carry neither, so the customer
  comes from the `order` row — in the **same query** as the consent projection, one read per event.
- **Adapters**: `CdpAdapter` with one method per call kind; `MemoryCdpAdapter` (a complete implementation, what
  runs today) and `RudderStackCdpAdapter` (data plane `identify` / `track` with the write key as HTTP Basic;
  suppression through the control plane's `Suppress_With_Delete` regulation, which **throws** without its own
  token and source ids rather than silently doing nothing). The write key never reaches a body, a log line, an
  error or the object. Not exercised against a real workspace: no account exists.
- **Dropped events are never silent**: one log line per drop with a reason code and no customer data; a dropped
  event is marked processed rather than retried forever.
- Config: `ENGAGEMENT_CDP_ENABLED` (default `0` — the consumer ships off), `ENGAGEMENT_CDP_ADAPTER`
  (`memory` refused in production when enabled), and the `RUDDERSTACK_*` credentials from the environment only.
- Tests: **160 passing, 6 live skipped** with the broker offline — mapper 25, consent 25, adapters 18, CDP
  consumer 16 (13 + 3 live), plus the #553 suites and the config tests.
- **The three #562 review nits**, folded in here rather than pushed onto the merged head:
  - the handlers no longer write the processed mark themselves. The SDK marks after a handler returns without
    throwing, so the explicit call was a redundant second INSERT of the same row. `ctx.markProcessed(tx)` is
    for a handler whose side effects are database writes; a Slack post and a CDP call cannot join a
    transaction, so there is nothing for it to commit with.
  - `ENGAGEMENT_DLQ_GROUPS` now defaults to **every** group this service runs (`KNOWN_GROUPS`), and the README
    says production must list every group on the bus - other windows' included, which a default cannot know.
  - the crash handler logs the error **class** only: a message or stack can carry a webhook URL, a write key
    or the row being handled.

## 0.1.0 — 2026-10-23 (#553, task 16.1)

The service, and ops alerts.

- **New package** `@platform/engagement` (`apps/engagement`): public API in `src/index.ts`, README, CLAUDE.md,
  scripts `dev` / `start` / `once` / `build` / `typecheck` / `test` / `lint`. No HTTP server yet (#556 adds one).
- **Ops-alert consumer** on group `engagement.ops` over the events-v1 SDK: `payment.failed`, `refund.failed`,
  `return.requested`. Dedupe through the shared `consumer_processed` table (packages/db 0202) with
  `createPgProcessedStore`, read and written by an **organization-scoped** client (the table is RLS kind
  `organization_only`). A redelivery sends nothing; a crash between the post and the mark can repeat one alert,
  deliberately — see README "Exactly what is guaranteed".
- **Rules** in one file as pure functions of (envelope, store code). `refund-failed` is `critical`.
  `return.requested.reason` is deliberately NOT in a message (free text a person typed); the PSP's
  `failure_reason` is.
- **Transports**: `AlertTransport` interface, `DevSinkAlertTransport` (JSON lines in `.engagement/`, refused in
  production) and `SlackAlertTransport` (`SLACK_OPS_WEBHOOK_URL` from the environment only, never logged,
  mrkdwn-escaped fields, a refusal reduced to status + Slack's error word). No Slack account exists yet; live
  use is on the launch checklist.
- **Rate limit** per (rule, store), fixed window in memory, carrying the suppressed count onto the next alert
  that goes out.
- **DLQ depth watch** over every configured consumer group with `readDeadLetters` against a threshold, counting
  error classes; an unreadable queue is depth 0 and a log line, never a throw.
- **Store codes**: `store_id` → `store.code`, cached, falling back to the uuid rather than dropping an alert.
- Tests: **71** — rules 16 (incl. the PII sweeps), transports 13, config 12, DLQ watch 8, rate limit 7, and
  consumer 15: 12 on a throwaway database (the `consumer_processed` guarantees from the consumer's side, store
  codes, the decision path) plus a 3-test live block against the local Redpanda. Each live test owns its topics
  under the run's prefix and stops its consumer before the next starts — they all join the real group
  `engagement.ops`, so sharing a topic let one test's message reach another test's consumer. The live block is
  skipped with a printed reason when the broker is down; with it up, 71/71 on three consecutive runs, ~26 s,
  every prefixed topic deleted and asserted gone.
- Built against `consumer_processed` while it was PR #557 (a copy of the file under `./migrations`, applied by
  the test to its own throwaway database — the #244 way). #557 merged on 2026-10-23 as packages/db 0.3.16, so
  the copy and its helper are gone and the tests run on the real migration.
