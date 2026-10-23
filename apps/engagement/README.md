# @platform/engagement

The engagement service (window 16, Phase 4): bus consumers for **ops alerts** (#553), and — as the following
tasks land — the CDP mapper (#554), CRM sync (#555) and the support-context API (#556). Owner: window 16.
Run/test commands and the public API: [CLAUDE.md](./CLAUDE.md); the outbox/bus design: ADR 0003; the consumer
SDK: `packages/events/README.md`.

Today it does one thing: it watches the bus for the three events an operator must not miss, and the dead-letter
queues of every consumer group, and posts to Slack — or, with no Slack account in existence yet, to a local
file.

## How it runs

`pnpm --filter @platform/engagement start` runs the ops consumer and polls the DLQs until SIGTERM.
`pnpm --filter @platform/engagement once` runs **one DLQ poll** and exits — the way to drive the watch from a
script or a CI job without a long-lived process. There is no HTTP server yet; #556 adds one.

One process serves one organization (`ENGAGEMENT_ORGANIZATION_ID`) and reads every store of it through an
**organization-scoped** client: `consumer_processed` is RLS kind `organization_only`, so a store-scoped session
reads and writes none of it.

### Environment

| Variable                          | Default           | Meaning                                                                            |
| --------------------------------- | ----------------- | ---------------------------------------------------------------------------------- |
| `DATABASE_URL_APP`                | —                 | the `platform_app` role (RLS applies); required                                    |
| `ENGAGEMENT_ORGANIZATION_ID`      | the seeded HQ     | the organization this process serves                                               |
| `ENGAGEMENT_TRANSPORT`            | `dev`             | `dev` (a local file) or `slack`; **`dev` is refused in production**                |
| `ENGAGEMENT_DIR`                  | `.engagement`     | where the dev sink writes (git-ignored)                                            |
| `SLACK_OPS_WEBHOOK_URL`           | —                 | the incoming-webhook URL, **environment only**; required for `slack`, never logged |
| `ENGAGEMENT_ALERT_RATE_MAX`       | `5`               | alerts per (rule, store) per window                                                |
| `ENGAGEMENT_ALERT_RATE_WINDOW_MS` | `900000` (15 min) | the window                                                                         |
| `ENGAGEMENT_DLQ_GROUPS`           | `engagement.ops`  | comma-separated consumer groups whose DLQ depth is watched                         |
| `ENGAGEMENT_DLQ_THRESHOLD`        | `1`               | alert when a group's live dead-letter count reaches this                           |
| `ENGAGEMENT_DLQ_POLL_MS`          | `60000`           | poll interval for the depth watch                                                  |
| `KAFKA_BROKERS`                   | `127.0.0.1:19092` | read by `@platform/events` (`createKafka`)                                         |

Locally: `.env` with the DB rows (loopback **127.0.0.1**, not `localhost` — Memory-main's IPv6 trap), nothing
else, then `pnpm --filter @platform/engagement dev`. Make a payment fail and
`.engagement/ops-alerts.jsonl` gains a line.

## Ops alerts (#553)

Consumer group **`engagement.ops`**, built on the events-v1 consumer SDK. Three rules, in `src/ops/rules.ts`:

| Rule               | Topic                 | Severity   | What the message carries                                           |
| ------------------ | --------------------- | ---------- | ------------------------------------------------------------------ |
| `payment-failed`   | `payment.failed`      | `warn`     | order id, payment id, amount + currency, provider, provider reason |
| `refund-failed`    | `refund.failed`       | `critical` | order id, refund id, payment id, amount + currency, reason         |
| `return-requested` | `return.requested`    | `warn`     | order id, return id, line count, unit count                        |
| `dlq-depth`        | (a poll, not a topic) | `critical` | group, depth, threshold, error classes counted, event topics       |

Every rule is a **pure function** of `(envelope, store code) → Alert | null`, so the whole rule set is tested
against schema-validated fixtures with no broker, database or transport. `refund-failed` is the critical one:
we owe a customer money and the automatic path is exhausted, and unlike a failed payment nobody else finds out.

### What is in a message, and what is not

Events carry no personal data (ADR 0003 item 5), and an alert adds only the store **code**, looked up by id. So
a message holds ids, integer minor-unit amounts with their currency, counts and provider reason codes. Two
deliberate decisions:

- **`failure_reason` is included** on the two payment/refund rules. It is the PSP's own reason code
  (`insufficient_funds`, `card_declined`) and the first thing an operator needs.
- **`return.requested.reason` is dropped**, although the schema has it. It is free text a customer or an agent
  typed into a form — the one field in these three topics that can hold a phone number or an address. The alert
  carries the ids and the counts; whoever opens the return in the admin reads the reason there, behind a
  permission check.

`ops/rules.test.ts` proves it: it fills every string the three payloads allow with personal data, renders every
alert **and its Slack payload**, and sweeps them; a separate test asserts a clean alert matches no e-mail, phone
or sha1/sha256 shape at all (uuids and timestamps are removed first — they are what an alert is made of).

### Exactly what is guaranteed

A Slack post is a network call and cannot join the transaction that writes the dedupe mark, so:

- **A redelivery sends nothing.** The SDK checks the shared `consumer_processed` table (group
  `engagement.ops`, key = the outbox id) _before_ it runs the handler, so a rebalance, a restart or a replay of
  a message this group already finished is a no-op. Proven against the real broker in the live block.
- **A crash between the post and the mark can repeat one alert.** The order is post, then mark. The other order
  would _lose_ the alert on the same crash. For ops alerts that trade is the right way round — a duplicate is
  cheap, a miss is the incident nobody hears about. This is the deliberate difference from
  `apps/notifications`, which must never send a second e-mail and therefore never retries a stuck row.
- A transport that keeps refusing is retried by the SDK and then **dead-lettered** to `dlq.engagement.ops` with
  the error class and no payload — which the depth watch then reports.

### Rate limit

At most `ENGAGEMENT_ALERT_RATE_MAX` alerts per **(rule, store)** per window, a fixed window in memory. One
noisy store cannot mute another, and one noisy rule cannot mute another rule on the same store.

A burst is never silent: the count the limit dropped rides on the next alert that does go out
(`Alert.suppressed` → "4 more of this rule suppressed by the rate limit"). The window is **in this process**:
one worker per organization, so a restart forgets it and the first alerts after a restart always go out. A
second worker would limit independently. If that is ever needed the window becomes a table keyed
(rule, store, bucket) — not built, not needed for one worker, and a missed ops alert is worse than a duplicate.

### DLQ depth watch

`readDeadLetters(group)` returns the **live** entries of `dlq.<group>` (successfully replayed ones are already
tombstoned), so its length is the depth. A poll, not a consumer: the DLQ is compacted and read from the
beginning, so there is no offset to keep and nothing to dedupe. The alert counts the error **classes** present
and lists the event topics — all there is to say, since a dead letter carries no payload, and enough to tell
"one poison message" from "the downstream API is down".

A group whose DLQ cannot be read (the topic does not exist because the group never dead-lettered anything, or
the broker is down) is reported as depth 0 and logged — never an alert, never a throw. The watch must not
become the thing that takes the service down. The rate limit keeps a standing backlog from paging every minute.

## Transports

`AlertTransport { name; send(alert) }` in `src/transport/types.ts` — the seam `apps/notifications` proved for
e-mail; a provider nobody can run yet is one file and a config value.

- **`dev`** (`DevSinkAlertTransport`): appends one JSON object per line to `<dir>/ops-alerts.jsonl`. JSON lines
  rather than a file per alert, because alerts are read as a stream (`tail -f` while reproducing, `jq` in a
  test). Refused in production.
- **`slack`** (`SlackAlertTransport`): posts the mrkdwn payload to the incoming webhook. The URL **is** the
  credential: environment only, never defaulted, never logged, not an enumerable property of the transport.
  A refusal becomes `TransportError("slack: HTTP <status> <word>")` — the status and Slack's own short error
  word (`invalid_payload`); any longer or HTML body is dropped, because a Slack error body can echo the payload
  back. 429 and 5xx are marked retryable. Every field value is mrkdwn-escaped, so a value cannot inject a Slack
  link. **Not exercised against a real workspace**: no Slack account exists (#553); live use is on the launch
  checklist.

## Schema

`consumer_processed` is `packages/db/migrations/0202_consumer_processed.sql` (db 0.3.16, #557, merged
2026-10-23) — the shared processed store for every Phase 4 bus consumer: `organization_id` DEFAULT the
session's organization (so the SDK's two-column INSERT is enough), PK `(group_id, outbox_id)` as the replay
guard, RLS `organization_only`, `UPDATE` revoked from `platform_app`. `createTestDatabase` applies it like
every other migration.

This service owns **no table of its own**: the marks are the shared table's, the rate-limit window is in
memory, and an alert is not stored anywhere but the transport.

## Tests

```
pnpm --filter @platform/engagement exec vitest run     # unit, plus a DB file and a live broker block
pnpm --filter @platform/engagement typecheck           # src and tests
pnpm lint && pnpm typecheck && pnpm test --filter @platform/engagement
```

- `ops/rules.test.ts` — every rule against envelopes validated by the real schemas, the null and
  zero-decimal-currency cases, and the PII sweeps.
- `ops/rate-limit.test.ts` — per-key windows, the window edge, the suppressed count, refusals.
- `transport/transport.test.ts` — the dev sink on a temp dir; Slack against an injected fetch (payload, escape,
  refusal → label only, retryable flags, and that the URL never reaches an error, an alert or the object).
- `config.test.ts` — defaults, the production refusals, the numbers, and that a webhook URL the transport will
  not use is not carried.
- `ops/dlq-watch.test.ts` — thresholds, several groups, the error-class counting, an unreadable DLQ, and the
  rate limit over a standing backlog, with the reader injected.
- `ops/consumer.test.ts` — on a throwaway database: the `consumer_processed` guarantees this consumer depends
  on, from the consumer's side (the PK as replay guard, a store-scoped session reading and writing none,
  `UPDATE` revoked, the `organization_id` default), store-code resolution, and the
  decision path. Then a **live block** on prefixed, self-cleaning topics: one alert per event and nothing for a
  redelivery; an event already marked for this group staying silent while an unmarked one alerts (fresh topics,
  so the mark is what silences it, not an offset that was never re-read); and a refusing transport
  dead-lettering with the error class and no payload, marking nothing. It is skipped with a printed reason when
  the broker is down.

  Each live test ensures **its own** topics under the run's prefix and stops its consumer before the next one
  starts. They all join the real group `engagement.ops`, so two live members would share the topic's partitions
  and a message published by one test could be handled by another test's consumer — which is how the
  dead-letter test first failed in a full-suite run after passing on its own.

## What is not here (and where it is tracked)

- **A real Slack post.** Blocked on the owner's workspace; on the launch checklist.
- The CDP mapper and tracking plan (#554), CRM sync (#555), the support-context API and Chatwoot webhook (#556).
- SMS/WhatsApp (Twilio), Novu and Klaviyo flows — deferred until accounts exist (manager decision on #553).
- The returns portal and refund limits by role — a later wave across core, auth, storefront and admin.
- This service's `COPY` lines in the Dockerfiles: the manager lands them as an integration commit on the 16.1
  head (a new workspace package reddens `app images` until every Dockerfile has them).
