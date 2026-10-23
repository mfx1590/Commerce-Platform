# @platform/engagement

## Purpose

The engagement service (window 16, Phase 4). Today: **ops alerts** (#553) — group `engagement.ops` over
`payment.failed`, `refund.failed`, `return.requested` plus a dead-letter depth watch, through a transport
(`dev` JSON-lines sink or a Slack webhook) — and the **CDP** (#554) — group `engagement.cdp`, 9 mapped
topics driven by `data/cdp/tracking-plan.json`, consent-gated off the `customer.consent` projection, with a
RudderStack adapter and an in-memory one. Coming: CRM sync (#555, `src/crm/`), the support-context API
(#556, `src/support/`). README.md has the design and the guarantees.

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
