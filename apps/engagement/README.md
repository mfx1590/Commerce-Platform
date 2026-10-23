# @platform/engagement

The engagement service (window 16, Phase 4): bus consumers for **ops alerts** (#553) and the **CDP** (#554),
and — as the following tasks land — CRM sync (#555) and the support-context API (#556). Owner: window 16.
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
| `ENGAGEMENT_CDP_ENABLED`          | `0`               | `1` starts the CDP consumer (off until an account exists)                          |
| `ENGAGEMENT_CDP_ADAPTER`          | `memory`          | `memory` or `rudderstack`; **`memory` is refused in production when enabled**      |
| `RUDDERSTACK_WRITE_KEY`           | —                 | the source write key, **environment only**, never logged                           |
| `RUDDERSTACK_DATA_PLANE_URL`      | —                 | the data plane, e.g. `https://hosted.rudderlabs.example`                           |
| `RUDDERSTACK_CONTROL_PLANE_URL`   | —                 | suppressions only (a different credential from the write key)                      |
| `RUDDERSTACK_ACCESS_TOKEN`        | —                 | suppressions only; without it a suppression **throws** instead of doing nothing    |
| `RUDDERSTACK_SOURCE_IDS`          | —                 | comma-separated source ids a suppression applies to                                |

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

## CDP (#554)

Consumer group **`engagement.cdp`**, same SDK and same marks as the ops consumer. What goes where is
`data/cdp/tracking-plan.json` — a reviewed artefact, not documentation written afterwards — and
`src/cdp/mapper.ts` executes it. A test asserts the two agree **in both directions**, and that the plan's
mapped and unmapped lists together cover every topic in the events contract exactly once: a new event in
`packages/events` fails the suite until someone writes down which it is, so it can be neither silently
forgotten nor silently sent to a third party.

9 topics are mapped — `customer.created` / `customer.updated` to `identify`, `customer.erased` to
`suppress`, and `order.placed`, `order.cancelled`, `payment.captured`, `refund.issued`, `shipment.shipped`,
`return.requested` to `track`. The other 29 are listed as unmapped with a reason. `data/cdp/README.md` holds
the rules and the reasoning; this section is how the code implements them.

### Consent

Read-only, from the **`customer.consent` projection** (packages/db 0005, which the core's consent ledger
rewrites in the same transaction as each 0194 `customer_consent` row), **evaluated at processing time** —
manager ruling, 2026-10-23. Never the ledger rows: window 13 owns their semantics, and "the newest row wins"
is theirs to change. If the projection's shape is ever not enough, that is a `REQUEST:` to window 13, not a
ledger read here. Purpose: `marketing_email`, the only one 0194 allows.

`customer.created` and `customer.updated` carry a `marketing_consent` field in their payload and **the mapper
ignores it on purpose.** A decision can therefore contradict the event's own snapshot — the event says
granted, the customer revoked in between, nothing is sent. That is the ruling working, not a bug, and a test
asserts the two events produce identical traits whatever that field says.

`customer.erased` is the one call **not** consent-gated: a suppression must go out precisely for the customer
who withdrew everything, and it still goes out when the customer row has already been deleted.

**The gate is a deliberate default pending a legal answer.** Whether analytics tracking needs consent at all,
and whether pseudonymous tracking of a guest is allowed, are on the owner's lawyer list (manager, 2026-10-23).
Until they come back: nothing without granted `marketing_email` for that store, and a guest event — no
`customer_id`, only an `email_hash` — is **dropped** rather than tracked pseudonymously. No CDP-specific
consent purpose is to be invented meanwhile. So guest orders do not reach the CDP: that is known, not missed.

### Two clients, for a structural reason

The CDP consumer runs **two** database clients:

- the **organization** client writes the marks — `consumer_processed` is RLS kind `organization_only`, so a
  store-scoped client can neither read nor write it;
- a **store-scoped** client, built per event for the **event's own store**, reads the consent projection and
  resolves the order's customer.

An organization client could do both (`app.can_access_store` is true for any store in organization scope), so
the second one is least privilege by choice: consent is per (customer, store, purpose) and 0194 says it is
never propagated across stores, so scoping that read to the event's store makes a cross-store consent read
impossible rather than merely wrong. A test proves another store's consent cannot grant a send.

### Identity

`customer_id` when known, else `email_hash`. The five order-scoped topics (`order.cancelled`,
`payment.captured`, `refund.issued`, `shipment.shipped`, `return.requested`) carry **neither** in their
payload, so the customer is read from the `order` row — in the **same query** as the consent projection.
One read per event, and never two sources of truth about who an event is about.

### What a dropped event leaves behind

Every drop is one log line with a reason code (`consent_absent`, `consent_revoked`, `customer_erased`,
`no_identity`, `customer_not_found`, `order_not_found`) and no customer data at all, because "the CDP is
empty" is otherwise an unanswerable question. A dropped event **is** marked as processed: it is finished, not
retried forever.

### Adapters

`CdpAdapter` has one method per call kind, so an adapter cannot silently skip one and the in-memory mock is a
complete implementation rather than a partial stub.

- **`memory`** (`MemoryCdpAdapter`): records identifies, tracks and suppressions and answers
  `isSuppressed(id)`. The only adapter that runs today, and what the tests assert on.
- **`rudderstack`** (`RudderStackCdpAdapter`): `POST /v1/identify` and `/v1/track` on the data plane, the
  write key as HTTP Basic with an empty password; the key never leaves the object and never reaches a body, a
  log line or an error. A suppression is **not** a data-plane call — it is `POST /v2/regulations`
  (`Suppress_With_Delete`) on the control plane, which needs a personal access token rather than the write
  key. Without that token and the source ids the adapter **throws**: an erasure that quietly fails is the one
  failure this service must never hide. Refusals become `CdpError` with the status only; 429 and 5xx are
  marked retryable. **Not exercised against a real workspace** — no account exists, which is also why
  `ENGAGEMENT_CDP_ENABLED` defaults to `0`; live use is on the launch checklist.

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
- `cdp/mapper.test.ts` — every mapped topic against schema-validated fixtures, the two-way agreement with
  the tracking plan, the deliberately dropped properties (tracking number, return reason, line titles and
  SKUs) and the PII sweeps.
- `cdp/consent.test.ts` — the gate (pure) over every outcome, and the two projection reads on a throwaway
  database: the shape the core actually writes, another purpose not granting ours, a malformed block reading
  as "never answered", per-store isolation, and that the read path writes nothing.
- `cdp/adapter/adapter.test.ts` — the memory adapter, and RudderStack against an injected fetch (request
  shape, Basic auth, the regulation call, the refusal to suppress without a control-plane token, and that the
  write key never reaches a body, an error or the object).
- `cdp/consumer.test.ts` — the decision path on a throwaway database (consent honoured over the payload's
  snapshot, guest dropped, erasure suppressed even with the row gone, per-store consent) plus its own live
  block.
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
- **A real CDP call.** Blocked on the owner's RudderStack account; the consumer ships disabled
  (`ENGAGEMENT_CDP_ENABLED=0`) and the live use is on the launch checklist.
- CRM sync (#555), the support-context API and Chatwoot webhook (#556).
- SMS/WhatsApp (Twilio), Novu and Klaviyo flows — deferred until accounts exist (manager decision on #553).
- The returns portal and refund limits by role — a later wave across core, auth, storefront and admin.
- This service's `COPY` lines in the Dockerfiles: the manager lands them as an integration commit on the 16.1
  head (a new workspace package reddens `app images` until every Dockerfile has them).
