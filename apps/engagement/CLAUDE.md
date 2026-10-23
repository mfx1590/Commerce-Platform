# @platform/engagement

## Purpose

The engagement service (window 16, Phase 4). Today: **ops alerts** (#553) — group `engagement.ops` over
`payment.failed`, `refund.failed`, `return.requested` plus a dead-letter depth watch, through a transport
(`dev` JSON-lines sink or a Slack webhook) — and the **CDP** (#554) — group `engagement.cdp`, 9 mapped
topics driven by `data/cdp/tracking-plan.json`, consent-gated off the `customer.consent` projection, with a
RudderStack adapter and an in-memory one — and **CRM sync** (#555) — group `engagement.crm`, one contact per
customer per store with a recomputed order/LTV rollup, PII from the core Admin API with this service's own
principal (#565), Twenty and in-memory adapters. Coming: the support-context API (#556, `src/support/`).
README.md has the design and the guarantees.

## Owner

window 16 (engagement), branch prefix `engagement/`. Owned paths: `apps/engagement/**`, `apps/support/**`,
`data/cdp/**`. **`apps/notifications` is window 17's** — it is the model for transports and exactly-once, never
a file to edit; a change there is a `REQUEST:` to window 17.

## Run / test

- `pnpm --filter @platform/engagement dev` — consumer + DLQ poll against `.env` (DB rows on 127.0.0.1)
- `pnpm --filter @platform/engagement start` / `once` (one DLQ poll, prints a report, exits)
- `pnpm --filter @platform/engagement build` / `typecheck` (src and tests) / `lint`
- `pnpm --filter @platform/engagement exec vitest run` — unit tests need nothing; `ops/consumer.test.ts`
  builds its own throwaway DB through `@platform/db/testing` and has a live broker block that skips with a
  printed reason when Redpanda is down (`pnpm compose:up`)
- Root: `pnpm lint && pnpm typecheck && pnpm test --filter @platform/engagement` before finishing any task.
- **Ask the manager for the machine before a live or full suite** (one window measures at a time).

## Layout

- `src/ops/rules.ts` — the rule set: pure `(envelope, store code) → Alert | null`. One file, by #553.
- `src/ops/consumer.ts` — group `engagement.ops`, the SDK wiring, and the post-then-mark decision
- `src/ops/rate-limit.ts` — fixed window per (rule, store), in memory; carries the suppressed count forward
- `src/ops/dlq-watch.ts` — `readDeadLetters` per group against a threshold; a poll, not a consumer
- `src/ops/store-codes.ts` — store_id → `store.code`, cached, uuid fallback
- `src/transport/` — `types.ts` (`AlertTransport`, `TransportError`), `dev-sink.ts`, `slack.ts`
- `src/cdp/mapper.ts` — pure `(envelope, identity + store code) -> CdpCall | null`; the plan's twin
- `src/cdp/consent.ts` — the projection reads and the gate; the ONLY CDP file that touches a database
- `src/cdp/consumer.ts` — group `engagement.cdp`, the two clients, post-then-mark, drop logging
- `src/cdp/adapter/` — `memory.ts` (runs today), `rudderstack.ts` (data plane + regulations)
- `src/crm/rollup.ts` — PURE orders/LTV rollup; recomputed, never accumulated (idempotency)
- `src/crm/read.ts` — the order and refund rows the rollup needs; no PII read from the tables
- `src/crm/admin-api.ts` — the ONLY PII read, via an injected `TokenProvider` (#565)
- `src/crm/consumer.ts` — group `engagement.crm`; consent before PII, erasure before everything
- `src/crm/adapter/` — `memory.ts` (runs today), `twenty.ts` (upsert by our id, never by e-mail)
- `src/config.ts` (env + production refusals), `src/main.ts`, `src/types.ts`, `src/index.ts`

## Public API

`src/index.ts`: `resolveConfig` / `buildTransport` / `main`; `createOpsConsumer` / `handleEvent` /
`OPS_GROUP_ID` / `PROCESSED_TABLE`; `evaluateRules` / `ruleTopics` / `OPS_RULES` and the three rules;
`createRateLimiter` / `rateLimitKey`; `createStoreCodes`; `pollDeadLetters` / `runDlqWatch` / `DLQ_RULE`;
`DevSinkAlertTransport` / `SlackAlertTransport` / `slackPayload` / `escapeMrkdwn` / `TransportError`;
`createCdpConsumer` / `handleCdpEvent` / `CDP_GROUP_ID`, `mapEvent` / `cdpTopics` / `isMapped` /
`isConsentGated` / `CDP_CALL_FOR` / `CDP_EVENT_NAME`, `gate` / `readCustomerFacts` /
`readOrderCustomerFacts` / `CONSENT_PURPOSE`, `MemoryCdpAdapter` / `RudderStackCdpAdapter` / `sendCall` /
`CdpError`; and the types (`Alert`, `CdpCall`, `CustomerFacts`, `DropReason`, …). Nothing imports this
package yet.

## Constraints

- Import other packages only through their public API (`@platform/<name>`), never `src/*`.
- Every consumer uses the events-v1 SDK (`createConsumer`), its own group per module, and the shared
  `consumer_processed` table through `createPgProcessedStore`. Never a hand-rolled offset or claim table.
- Every DB access through `@platform/db`'s scoped client, **organization scope**: `consumer_processed` is RLS
  kind `organization_only`, so a store-scoped client reads and writes none of it.
- **No PII in an alert, a log line or an error.** Events carry none (ADR 0003 item 5); the only additions are
  the store code and provider reason codes. `return.requested.reason` is free text and is deliberately
  dropped — see README. A log line never carries an alert's `fields`.
- No secrets in code. `SLACK_OPS_WEBHOOK_URL` is read in `config.ts` only, never defaulted, never logged, never
  in an error message. **Test keys and tokens must read as words, never digit/hex tails** (gitleaks scans every
  branch's whole history; one secret-shaped literal reddens every open PR).
- Post **then** mark, never the reverse: a duplicate ops alert is cheap, a missed one is an unseen incident.
  (The opposite of `apps/notifications`, which must never send twice.)
- The DLQ watch never throws on an unreadable queue; it reports depth 0.
- `ENGAGEMENT_DLQ_GROUPS` defaults to `KNOWN_GROUPS` (every group this service runs) and **must list every
  group on the bus in production**, other windows' included - an unwatched group's dead letters are silent. A
  new consumer group here is a new entry in `KNOWN_GROUPS`.
- **Do not write the processed mark yourself.** The SDK marks after a handler returns without throwing;
  `ctx.markProcessed(tx)` is only for a handler whose side effects are DATABASE writes, so the mark commits
  with them. Ours are HTTP calls, so there is nothing to join and calling the store would double the INSERT.
- A crash or error log carries the error CLASS only: a message or stack can hold a webhook URL, a write key or
  the row it was handling.
- **CRM is the only module that touches PII.** It comes from the Admin API with this service's own principal,
  never from an event and never from a direct table read (which would bypass the permission check). It lives
  in a `CrmContact` on the way to the adapter and reaches no log line, error, dead letter or row of ours.
- **Upsert a CRM contact by OUR `customer.id`, never by e-mail** (#555): an address changes and two people
  share one. A failed lookup must not fall through to a create.
- **Recompute the rollup; never accumulate it.** A counter cannot tell a redelivery from a second order, and
  the bus is at-least-once and replayable. Recomputing is what makes the sync idempotent.
- The rollup's order and refund reads are READ-ONLY through a store-scoped client on the event's own store
  (the apps/notifications render-data precedent); two tests pin it — another store's order never enters the
  rollup, and the path writes nothing.
- The live broker blocks do NOT run in CI (no broker there): they skip with a printed reason, so a broker-up
  run before finishing a task is how those guarantees get proven. Ask for the machine first.
- Consent gates the whole CRM contact and is checked BEFORE the PII is fetched; `customer.erased` deletes
  before anything is read and `remove` is idempotent.
- `ENGAGEMENT_CRM_TOKEN_PROVIDER=client_credentials` throws until #565 is built — never fall back to the mock.
- **CDP consent is READ-ONLY, from the `customer.consent` PROJECTION, at processing time** (manager ruling
  2026-10-23). Never the `customer_consent` ledger rows (window 13's semantics — a `REQUEST:` if the
  projection is not enough), never a write to either, never an API hop. Ignore the `marketing_consent` field
  in the `customer.created` / `customer.updated` payloads: it is a snapshot, the projection is the truth.
- The CDP consumer needs TWO clients: the organization one for the marks (`consumer_processed` is
  `organization_only`), and a store-scoped one per event for the consent read (least privilege — consent is
  never propagated across stores).
- No identify or track without granted consent; `customer.erased` is the only ungated call; a guest (no
  `customer_id`) is dropped, not tracked pseudonymously. That gate is the Phase 4 default pending the owner's
  lawyer answer — do not widen it, and do not invent a consent purpose.
- A new topic in `packages/events` must be added to `data/cdp/tracking-plan.json` as mapped or unmapped with a
  reason; the suite fails until it is.
- Never touch a Dockerfile: the manager lands this service's `COPY` lines as an integration commit.
- Update README.md and CHANGELOG.md with every change, and the memory file before every commit.
