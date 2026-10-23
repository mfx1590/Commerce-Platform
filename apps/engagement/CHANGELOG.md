# @platform/engagement

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
- Tests: 68 — rules 16 (incl. the PII sweeps), rate limit 7, transports 13, config 12, DLQ watch 8, consumer 12
  on a throwaway database (the `consumer_processed` guarantees, store codes, the decision path) plus a 3-test
  live block against the local Redpanda on prefixed self-cleaning topics, skipped with a printed reason when
  the broker is down.
- `migrations/0202_consumer_processed.sql` is a **copy** of the real file while PR #557 is open (the #244 way),
  applied by the test to its own throwaway database. It goes once 0202 is on main.
