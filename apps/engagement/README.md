# @platform/engagement

The engagement service (window 16, Phase 4): bus consumers for **ops alerts** (#553), the **CDP** (#554) and
**CRM sync** (#555), plus the **support-context API** (#556). Owner: window 16.
Run/test commands and the public API: [CLAUDE.md](./CLAUDE.md); the outbox/bus design: ADR 0003; the consumer
SDK: `packages/events/README.md`.

Today it does one thing: it watches the bus for the three events an operator must not miss, and the dead-letter
queues of every consumer group, and posts to Slack — or, with no Slack account in existence yet, to a local
file.

## How it runs

`pnpm --filter @platform/engagement start` runs the ops consumer and polls the DLQs until SIGTERM, plus any of
the CDP consumer, the CRM consumer and the support HTTP server that are enabled.
`pnpm --filter @platform/engagement once` runs **one DLQ poll** and exits — the way to drive the watch from a
script or a CI job without a long-lived process. The support API (#556) is the one HTTP server here, and it is off unless asked for.

`pnpm --filter @platform/engagement drain` (`--drain`) is the **one-shot measurement mode** (#594): it starts
every enabled consumer, reads its topics **from the beginning**, waits until the bus has gone quiet, stops and
prints one report — events handled per module, counts by event, by drop/skip reason, by rule and by call, each
consumer's own counters beside them as a cross-check, and the dead letters of the groups it ran. It is a mode
rather than a script because the measurement has to be the real wiring: the same consumers, the same handlers,
the same marks, differing only in the group id and in stopping by itself. Pair it with a FRESH group per
module (`ENGAGEMENT_OPS_GROUP_ID`, `ENGAGEMENT_CDP_GROUP_ID`, `ENGAGEMENT_CRM_GROUP_ID`) so a one-off run
re-reads history without moving the live group's offsets:

```
ENGAGEMENT_CDP_GROUP_ID=engagement.cdp.int4 pnpm --filter @platform/engagement drain
```

Both modes build their consumers through the same `buildConsumers`, so a group override moves the consumer
AND its DLQ watch together (#599) — and `resolveConfig` refuses to start at all if an explicit
`ENGAGEMENT_DLQ_GROUPS` omits a group this process runs, exiting **2** with a message naming it. More
watched groups than we run is fine; fewer is the failure that issue was about.

**A drain refuses the live groups** (#646). It reads from the beginning and commits offsets under whatever
group it joins, so omitting `ENGAGEMENT_*_GROUP_ID` used to rebalance the running consumer, move its offsets
and report the live dead-letter queue as its own. A drain on a live default now exits **2** naming the
group(s) and the way out. It checks only the modules that would actually run.

### Exit codes

| Code | Meaning                                                                                                                                                                                                                                                                          |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | the process did what it was asked: a clean drain, a DLQ poll, or a service stopped by SIGTERM                                                                                                                                                                                    |
| `1`  | the process FAILED at runtime — the crash line carries the error class only, never its message                                                                                                                                                                                   |
| `2`  | the CONFIGURATION was refused (`ConfigRefusedError`): nothing started, and the crash line carries the message, because this repository builds it from variable names and values it chose. A supervisor must not restart on this one — the same environment will be refused again |
| `3`  | a `--drain` RAN but its result is not clean: dead letters, a dead-letter queue that could not be read (`-1`), or `max_run`. The report says `clean: false` for the same reason                                                                                                   |

**And a drain says whether its result is clean**, in the report and in the exit code (#646): **3** when
there were dead letters, when a dead-letter queue could not be READ (`-1` — the number nobody has is not
zero), or when the run stopped at its ceiling (`max_run`, so "nothing left" was never established). A
scripted gate can therefore read the code instead of parsing the table. **2** stays "the configuration was
refused" and **1** "the process failed".

Stopping is a rule, not a timeout: a fresh group has to join and be assigned partitions before anything can
arrive, so "nothing yet" and "nothing left" are the same for the first seconds. A run therefore lasts at least
`ENGAGEMENT_DRAIN_MIN_RUN_MS` (20 s) and ends `ENGAGEMENT_DRAIN_IDLE_MS` (10 s) after the last batch —
reporting `idle`, `empty` (nothing ever arrived) or `max_run` (10 min), because a run that cannot stop is a
result, not something to swallow.

One process serves one organization (`ENGAGEMENT_ORGANIZATION_ID`) and reads every store of it through an
**organization-scoped** client: `consumer_processed` is RLS kind `organization_only`, so a store-scoped session
reads and writes none of it.

### Environment

| Variable                              | Default            | Meaning                                                                                |
| ------------------------------------- | ------------------ | -------------------------------------------------------------------------------------- |
| `DATABASE_URL_APP`                    | —                  | the `platform_app` role (RLS applies); required                                        |
| `ENGAGEMENT_ORGANIZATION_ID`          | the seeded HQ      | the organization this process serves                                                   |
| `ENGAGEMENT_TRANSPORT`                | `dev`              | `dev` (a local file) or `slack`; **`dev` is refused in production**                    |
| `ENGAGEMENT_DIR`                      | `.engagement`      | where the dev sink writes (git-ignored)                                                |
| `SLACK_OPS_WEBHOOK_URL`               | —                  | the incoming-webhook URL, **environment only**; required for `slack`, never logged     |
| `ENGAGEMENT_ALERT_RATE_MAX`           | `5`                | alerts per (rule, store) per window                                                    |
| `ENGAGEMENT_ALERT_RATE_WINDOW_MS`     | `900000` (15 min)  | the window                                                                             |
| `ENGAGEMENT_DLQ_GROUPS`               | the groups it runs | groups whose DLQ depth is watched; **production must list every group on the bus**     |
| `ENGAGEMENT_CRM_MOCK_TOKEN`           | –                  | **dev stand-in for the `crm-sync` principal (#565); never in production** (#594)       |
| `ENGAGEMENT_CRM_TOKEN_PROVIDER`       | **none**           | `client_credentials` or `mock`; **no default when the CRM is enabled** (#646)          |
| `CRM_SYNC_CLIENT_ID`                  | `crm-sync`         | the confidential service account for CRM sync (#565)                                   |
| `CRM_SYNC_CLIENT_SECRET`              | –                  | its secret, from Vault in production; required with `client_credentials`               |
| `ENGAGEMENT_OPS_GROUP_ID`             | `engagement.ops`   | the ops consumer group; a fresh id re-reads history without moving the live offsets    |
| `ENGAGEMENT_CDP_GROUP_ID`             | `engagement.cdp`   | the CDP consumer group (same rule)                                                     |
| `ENGAGEMENT_CRM_GROUP_ID`             | `engagement.crm`   | the CRM consumer group (same rule)                                                     |
| `ENGAGEMENT_DRAIN_IDLE_MS`            | `10000`            | `--drain`: quiet for this long after the last batch = drained                          |
| `ENGAGEMENT_DRAIN_MIN_RUN_MS`         | `20000`            | `--drain`: no run ends sooner, so a slow group join is not read as an empty bus        |
| `ENGAGEMENT_DLQ_THRESHOLD`            | `1`                | alert when a group's live dead-letter count reaches this                               |
| `ENGAGEMENT_DLQ_POLL_MS`              | `60000`            | poll interval for the depth watch                                                      |
| `KAFKA_BROKERS`                       | `127.0.0.1:19092`  | read by `@platform/events` (`createKafka`)                                             |
| `ENGAGEMENT_CDP_ENABLED`              | `0`                | `1` starts the CDP consumer (off until an account exists)                              |
| `ENGAGEMENT_CDP_ADAPTER`              | `memory`           | `memory` or `rudderstack`; **`memory` is refused in production when enabled**          |
| `RUDDERSTACK_WRITE_KEY`               | —                  | the source write key, **environment only**, never logged                               |
| `RUDDERSTACK_DATA_PLANE_URL`          | —                  | the data plane, e.g. `https://hosted.rudderlabs.example`                               |
| `RUDDERSTACK_CONTROL_PLANE_URL`       | —                  | suppressions only (a different credential from the write key)                          |
| `RUDDERSTACK_ACCESS_TOKEN`            | —                  | suppressions only; without it a suppression **throws** instead of doing nothing        |
| `RUDDERSTACK_SOURCE_IDS`              | —                  | comma-separated source ids a suppression applies to                                    |
| `ENGAGEMENT_CDP_CONSENT_MODE`         | `analytics`        | global consent mode: `analytics` or `strict` (#576); an unknown value fails the boot   |
| `ENGAGEMENT_CDP_CONSENT_MODE_<STORE>` | the global         | per-store override, e.g. `..._BRAND_A=strict` — one region made strict, no code change |
| `ENGAGEMENT_CRM_ENABLED`              | `0`                | `1` starts the CRM consumer (off until a CRM and #565 exist)                           |
| `ENGAGEMENT_CRM_ADAPTER`              | `memory`           | `memory` or `twenty`; **`memory` is refused in production when enabled**               |
| `ENGAGEMENT_CRM_TOKEN_PROVIDER`       | `mock`             | `mock` or `client_credentials`; **`mock` is refused in production**                    |
| `TWENTY_BASE_URL`                     | —                  | Twenty's REST base, e.g. `https://crm.example/rest`                                    |
| `TWENTY_API_KEY`                      | —                  | the Twenty key, **environment only**, never logged                                     |
| `TWENTY_EXTERNAL_ID_FIELD`            | `externalId`       | the custom person field holding OUR customer id (the upsert key)                       |
| `ADMIN_API_URL`                       | `localhost:9000`   | the core Admin API the contact's name and e-mail are read from                         |
| `ENGAGEMENT_SUPPORT_ENABLED`          | `0`                | `1` starts the support HTTP server                                                     |
| `ENGAGEMENT_SUPPORT_PORT`             | `4040`             | the port it listens on                                                                 |
| `ENGAGEMENT_SUPPORT_MAX_ORDERS`       | `25`               | how many of a customer's orders are detailed, newest first                             |
| `CHATWOOT_WEBHOOK_SECRET`             | -                  | HMAC secret, **environment only**; without it the webhook route answers 503            |
| `ENGAGEMENT_DEV_TOKENS`               | `0`                | `Bearer dev:<subject>` on the support routes; **refused in production**                |

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

**`ENGAGEMENT_DLQ_GROUPS` must name every group in production.** The default is every group this service runs
(`engagement.ops`, `engagement.cdp`) — "all of mine" rather than "the one I am", because a group missing from
the list is a group whose dead letters nobody is ever told about. But a default can only know its own groups:
other windows' consumers (`accounting`, and whatever Phase 5 adds) are invisible to it, so in production the
variable is set explicitly, and listing them all is the whole point of the watch. `KNOWN_GROUPS` in
`src/config.ts` is the default's source, so a new consumer group here means a new entry there.

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

9 topics are mapped. `identify` carries **ids only** — `customer_id`, `email_hash`, store code — in both
consent modes (#576): `status` and `customer_group_id` were dropped, the latter being a marketing segment id.
The mapping: `customer.created` / `customer.updated` to `identify`, `customer.erased` to
`suppress`, and `order.placed`, `order.cancelled`, `payment.captured`, `refund.issued`, `shipment.shipped`,
`return.requested` to `track`. The other 29 are listed as unmapped with a reason. `data/cdp/README.md` holds
the rules and the reasoning; this section is how the code implements them.

### Consent mode (#576)

The owner answered the two questions #554 left open, on 2026-10-23: analytics tracking without a marketing
consent is **allowed**, and so is tracking a guest under their `email_hash`. Counting our own commerce events
is analytics rather than marketing. Region rules come later, so the switch is config:

| Mode                      | `track` / `identify`                          | A guest (no `customer_id`)       |
| ------------------------- | --------------------------------------------- | -------------------------------- |
| **`analytics`** (default) | run without `marketing_email`                 | tracked under their `email_hash` |
| `strict`                  | need granted `marketing_email` for that store | dropped                          |

**It resolves per store.** `ENGAGEMENT_CDP_CONSENT_MODE` is the global default; `..._<STORE_CODE>` overrides it
for one store (`ENGAGEMENT_CDP_CONSENT_MODE_BRAND_A=strict`). Each brand is one market (A=EU, B=UK, C=US), so
a per-store switch is a per-region switch. The mode is resolved **per event** from the store the event names,
and lands on every per-event log line as `consent_mode`, so a quiet CDP is explainable per store. An unknown
value **fails the boot** rather than falling back to the open mode, and a caller that passes no mode at all
gets `strict` — the cautious direction in both cases.

**So does a bad KEY** (#586). The store part is normalised the same way when the override is read and when it
is looked up (`brand-a` → `BRAND_A`), so `..._brand_a`, `..._brand-a` and `..._BRAND_A` are one and the same
switch; two spellings of one store that DISAGREE fail the boot, since there is no safe answer. And an
override that names no store at all — `..._BRANDA` — **stops the boot**: `main()` warms the store list and
checks the keys BEFORE it starts a single consumer, then exits non-zero with a crash line naming
`ConsentModeConfigError`, the variable, and the store codes that do exist. The order matters more than it
looks: a consumer that is already running keeps the process alive, so a refusal raised after `start()` can
only set an exit code that never takes effect (#590 review — it did exactly that). The check needs the store
list, which is why it is not in `resolveConfig`; while the CDP is disabled there is nothing to check. The
failure all of this prevents is the quiet one: a typo leaving that store on `analytics` while the
configuration says `strict`.

**An empty per-store value is refused, not defaulted** (#644): `ENGAGEMENT_CDP_CONSENT_MODE_BRAND_A=` —
an unresolved secret-manager template, a stray `=` in a compose file — used to fall back to the global mode,
so a store was tracked while the operator believed it was strict. A missing variable is a default; an empty
one is something somebody wrote, and it exits 2 naming the variable. **And an override that cannot say which store it
means refuses the boot**: `brand-a` and `brand_a` are both `BRAND_A`, and `store.code` is unique per
organization only as text, so both can exist — an override on that key would silently apply to both, so it
is refused, naming the pair. It refuses only when an override actually USES the ambiguous key: without one
the collision changes nothing (both stores take the global mode), and store codes are created from the
onboarding UI, so refusing on any collision would let one store creation stop the CDP for every store.

**Two residual behaviours, documented rather than changed** (#644, both minor and both reachable only when a
row is missing):

- **A store whose `store.code` cannot be resolved falls back to its uuid**, and a uuid matches no per-store
  key, so that store resolves to the GLOBAL mode. The fallback is deliberate (#553: an alert is never
  dropped because a lookup failed), and the alternative — dropping the event — would lose data for a
  transient failure. It is reachable only when the store row is gone, and the effective mode is on every
  per-event log line, so it is visible rather than silent.
- **A customer row that is gone, in `analytics` mode, is tracked under the payload's `email_hash`** — i.e.
  as a guest, which is what it is indistinguishable from at the gate: the consumer normalises a not-found
  customer's id to null before gating, so a vanished row and a genuine guest arrive identically. Unreachable
  today, because the core keeps an erased customer with `status = 'erased'` and that is refused in both
  modes. A test pins it; changing it would mean plumbing "the payload named a customer" through to the gate.

Two things `analytics` does not relax, because neither is about consent: an **erased** customer is never sent
in either mode (the erasure told every consumer to delete its copies; tracking them again would undo it), and
a vanished order or customer row is still reported as such. And **CRM sync is untouched** — it stays
consent-gated in every mode, because putting a name and an e-mail into a third-party CRM is a different act
from counting an order. A test asserts the mode cannot reach it.

A guest is only trackable where an identity exists: of the six mapped commerce topics only `order.placed`
carries an `email_hash`, so a guest's _Order Completed_ reaches the CDP while their later _Order Shipped_ does
not. `data/cdp/README.md` records that asymmetry; closing it by reading the order's raw e-mail was refused
(manager ruling 2026-10-24), and the way in, if guest analytics ever matters, is a contract change adding
`email_hash` to those five topics.

### Consent

In `strict` mode, and for the `identify` of a known customer, the consent itself is read
read-only, from the **`customer.consent` projection** (packages/db 0005, which the core's consent ledger
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

## CRM sync (#555)

Consumer group **`engagement.crm`** over `customer.created`, `customer.updated`, `customer.erased`,
`order.placed`, `order.cancelled` and `refund.issued`. It keeps one CRM contact per customer per store, with
the name, the e-mail and an order/LTV rollup, and deletes the contact on erasure. Twenty is the adapter
(open-source, self-hostable); HubSpot would be a second file behind the same interface.

**This is the only module in the service that handles personal data.** Everything else works from events,
which carry none by contract (ADR 0003 item 5). The rules that follow from that are below.

### The upsert key is our customer id, never the e-mail

Twenty's REST API has no upsert verb, so the adapter looks up the person whose external-id field equals our
`customer.id`, then PATCHes that one or POSTs a new one. The filter is on that field and never on the address,
because an e-mail changes, two people share one, and a match on it would merge two strangers' purchase
histories. A test asserts two customers sharing an address stay two contacts, and another asserts an
unreadable lookup response **fails** rather than falling through to a create that would duplicate the person.

### The rollup is recomputed, never accumulated

`orders_count`, net revenue in minor units with its currency, and the last order date come from
`computeRollup`, a pure function over the customer's own order and refund rows. The obvious alternative — `+1
order` on `order.placed`, `-amount` on `refund.issued` against a stored counter — is wrong here for one reason
that outweighs its convenience: **it is not idempotent.** The bus is at-least-once and replayable, so a
redelivery, a DLQ replay or a consumer rebuilt from the beginning would double-count, and no counter can tell a
second delivery from a second order. Recomputing makes the sync idempotent _by construction_: a test handles
the same event twice and asserts the contact is identical and the numbers did not move. It also means this
service still owns no state.

What the rollup decides, with the reasons in `rollup.ts`:

- a **cancelled** order is not counted at all, not even as an order netted to zero — "2 orders" in a CRM
  should mean what a reader thinks it means;
- only a **succeeded** refund reduces revenue: a `pending` one may never happen and a `failed` one did not
  (and `refund.failed` is an ops alert, not a revenue event);
- a refund against a cancelled order is **not** subtracted, because that revenue was never counted;
- net is **floored at zero** — goodwill refunds and order edits can exceed a total, and a CRM showing negative
  lifetime revenue is worse than one showing zero. `gross_revenue_minor` and `refunded_minor` keep the
  unclamped figures, so nothing is hidden;
- currencies are **kept apart**, never summed. The headline is the store's `default_currency`; a customer with
  orders in another currency sets `mixed_currency`, and `by_currency` has the per-currency totals.

**Where the breakdown stops.** `by_currency` and `mixed_currency` do **not** cross the `CrmContact` boundary: a
CRM person has one revenue field, and inventing `netRevenueEur` / `netRevenueGbp` per workspace would be a
schema this service does not own. So for a mixed-currency customer the contact's `ordersCount` (all currencies)
and `netRevenueMinor` (the store's default only) disagree in scope, and **the only place that says so is the
`mixed_currency` field on the consumer's log line.** If a workspace ever needs the breakdown it is a
per-currency custom field and an adapter change, not a wider `CrmContact`.

### The reads are read-only, and scoped to the event's store

The order and refund rows the rollup is built from are read through a **tenant client scoped to the event's own
store**, read-only — the `apps/notifications` render-data precedent: the numbers come from the database rather
than from the payload, and the client that reads them can reach nothing else. Two tests hold the line: one
writes an order in store B carrying a store-A customer's id (an anomaly only the owner role could create) and
asserts it contributes **nothing** to that customer's rollup, because RLS makes it unreachable rather than
because our SQL filters it; the other asserts the whole rollup path leaves the order, refund and customer tables
**unchanged down to the row contents** — an `md5` over every row of each table, ordered, so a changed column
anywhere fails it and not merely a changed count or timestamp (#568 review: the first version checked counts
plus `max(updated_at)`, which is weaker than the claim it was making).

The PII is the one thing NOT read from the tables, even though `customer.email` is right there: it comes from
the Admin API with this service's own permission, so the permission check is never bypassed.

### Consent gates the whole contact

A CRM contact is marketing-shaped, so without granted consent **nothing** is synced — not a name, not a
number (manager decision on #555). It is the same gate as the CDP, from the same `customer.consent` projection
through the same store-scoped client, so there is one consent rule in this service and not two.

The order matters: the gate runs **before** the Admin API call, so a customer without consent has their
personal data fetched not at all, rather than fetched and discarded. A test asserts the reader was never
called.

`customer.erased` is the exception, and it deletes before anything is read: no consent lookup, no PII fetch,
just `remove(customerId)`. It works when the customer row is already gone (erasure deletes it), because the
identity comes from the payload there, and `remove` is idempotent by contract so a redelivered erasure is a
second success rather than a failure.

### Where the name and the e-mail come from

The core Admin API, with **this service's own principal** and the least permission that does the job: two
read-only operations, `listCustomers` and `getCustomer`, each `support` on `store:{storeId}`. The service
account is `REQUEST: crm-sync service client` (#565 — accepted, routed to window 2): a confidential `staff`
client with an audience mapper to `core-api`, a `staff_user` row for its subject, and `support` granted **per
synced store** rather than on the organization.

Until that exists the token comes from an injected `TokenProvider`, which is why `admin-api.ts` takes one
rather than reading the environment: `mockTokenProvider` is what the tests and local runs use, and
`ENGAGEMENT_CRM_TOKEN_PROVIDER=client_credentials` **throws** rather than silently falling back to the mock.
The mock is refused in production outright. Nothing here caches a token — the provider is asked on every
call, so a rotated secret needs no restart of ours.

A 404 from the Admin API is an answer (the customer is gone), not a failure. A 401 or 403 is marked
**retryable**, because the usual cause is the service principal not being seeded yet rather than a permanent
refusal. No response body ever reaches an error message: it is the one payload in this service full of
personal data.

### What never leaves

The name and the e-mail exist in a `CrmContact` on its way to the adapter and nowhere else. A log line carries
the customer **id**, the store code, the counts and a reason code — never a name, an address or an e-mail, and
a test sweeps every line of the busiest path for all three. Nothing of the contact is in a dead letter, an
error message or a row of ours, because we keep no rows.

## Support context (#556)

One HTTP server, three routes, for a Chatwoot dashboard app that needs to answer "who is this customer and what
happened to their orders" without making six Admin API calls and joining them itself.

| Route                                                         | Who       | What                                                                                           |
| ------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------- |
| `GET /health`                                                 | anyone    | liveness; no data                                                                              |
| `GET /support/customers/:customerId/context?store=<code\|id>` | the agent | the customer, their orders with payments, refunds, shipments and returns, and a glance summary |
| `POST /webhooks/chatwoot`                                     | Chatwoot  | HMAC verified, nothing persisted                                                               |

### The agent's own token, not a service principal

This is the deliberate difference from CRM sync (#555), which has no human in the request and therefore needs
one. Here **the agent's own token does the reading** (manager decision on #556), so an agent sees exactly what
their `support` role may see, and the core remains the authority on that.

Two gates run before any read, in this order:

1. **Who** — a staff-realm JWT through `@platform/auth-sdk`, then the subject looked up in `staff_user`: a
   token is a claim, the row is the fact. Unknown or disabled is 401.
2. **What** — `support` on `store:<id>` through OpenFGA, server-side. A staff user of this organization who is
   not support for _this_ store gets 403, and so does one asking about another store.

Then the agent's own `Authorization` header is forwarded to every Admin API call, so **the core checks the same
agent again** with its own `x-permission` rules. That is defence in depth rather than redundancy: this check
decides whether to make the call at all (and gives the agent a clean 403 instead of a leaked upstream error),
and the core's check is the authority on the data. If they ever disagree, the core wins and nothing leaks. A
test asserts every read carried the agent's header and that a refused gate makes **no** call at all.

When OpenFGA is unreachable the answer is **503, not 403**: the agent is not forbidden, we cannot tell. Failing
closed and saying which kind of closed it is.

### What it reads, and the one contract change it needed

Three read-only operations, all already in the contract: `getCustomer` (`support` on the store), `listOrders`
and `getOrder` (`viewer`, which `support` implies in the model). `getOrder` already embeds payments, refunds,
shipments and returns, so the whole history is one list call plus one detail call per order — no new endpoint
and no join of ours.

The one gap was listing a customer's orders: `listOrders` had no `customer_id` filter, though `OrderSummary`
already returned the field. That is `CONTRACT CHANGE` **#569** — accepted, Admin API 0.4.24. The alternative,
`q=<the customer's e-mail>`, was rejected for reasons worth keeping: it puts an address in a URL (every proxy
and access log then holds it), and `q` is a _search_ rather than a key, so two customers sharing an address
would see each other's orders.

### The response types come from the contract, not from guesses

`admin-api.ts` types its three responses from `@platform/contracts/admin`, generated from `admin-api.yaml`:

| Operation     | Body                                                                                    |
| ------------- | --------------------------------------------------------------------------------------- |
| `getCustomer` | `Customer`, **directly** — no envelope                                                  |
| `getOrder`    | `Order`, **directly** — and it embeds payments, refunds, shipments and returns          |
| `listOrders`  | the shared `Page` wrapper plus `items` — **not** `orders`. Note `Page.total` is a COUNT |

Money is `Money { amount_minor, currency }` everywhere, including `OrderSummary.total`, which is the **only**
place a summary carries a currency.

The first version of this file guessed those shapes and got two wrong: it read `body.orders` and treated
`total` as a scalar with a top-level `currency`. Against the real core every customer would have shown zero
orders and an empty currency, and the tests could not catch it because they drove a hand-written fake
(#573 review). Every fixture in the support tests is now typed from the contract's own schemas, so the next
such drift is a **compile** error rather than a silent empty answer.

### Ids in paths

Every id is validated as a uuid **in the route, before any call**, and answers 404 when it is not one: a
non-uuid cannot be one of our customers, and 404 is the same answer a real-but-absent id gets, so the two are
not distinguishable. The reader then `encodeURIComponent`s every path segment as a second line, because
`%2F..%2F` decodes to `/../` and an unvalidated id could otherwise climb out of the resource and hit another
Admin API route **with the agent's own token**. Tests cover both the malformed id and the encoded traversal,
and assert neither reaches the core.

**Known limit:** the store lookup runs _before_ the permission check, so an authenticated staff user who is
support for no store can still learn which store codes exist, from the difference between 404 (no such store)
and 403 (not yours). Narrowing it would mean checking a permission against a store not yet resolved, or
answering 403 for an unknown store and so lying to an operator debugging a typo. It is recorded rather than
fixed: the caller is already an active staff user of this organization, for whom the store list is not a
secret.

### Nothing is kept

No cache and no copy: the answer is assembled per request and forgotten. A cache would be both a stale
permission (the agent's rights are only true at the moment the core says so) and a copy of personal data, which
#556 forbids. Every response carries `cache-control: no-store`, so a proxy or a browser does not keep one
either.

A log line carries the customer **id**, the store code, the staff user id and the order count — never a name,
an address, an e-mail or a tracking number. A test sweeps for all four.

### Partial answers are visible

An order whose detail cannot be read still appears, built from its summary, with a line in `notes` saying what
is missing. An agent told "3 orders" when there are 4 would give a customer wrong information, which is worse
than a visible gap. A 401 or 403 from the core is **re-thrown**, not noted: that is a refusal, not a gap.

A customer who is not in this store gets the same 404 as one who does not exist, so the route cannot be used to
discover that an id exists elsewhere in the organization.

### The Chatwoot webhook, and its documented limit

The stub verifies the signature — **HMAC-SHA256 over the raw body**, hex, accepting either a bare digest or a
`sha256=<hex>` prefix — hashes the contact's address on arrival, and returns the conversation → `email_hash`
link.

**Chatwoot's own header format is not confirmed.** I could not find its documented header name or signing
scheme, so this implements the standard construction and accepts both shapes rather than inventing a specific
one; the exact header, prefix and encoding must be checked against a real delivery or the Chatwoot source
before go-live, which is a launch-checklist item next to "a real Chatwoot instance". The first version of this
computed `sha256(secret + '.' + body)` — a keyed hash, **not** an HMAC: no inner/outer padding, and the
construction length-extension attacks are written about. A test now asserts the old value is rejected. **It resolves nothing and persists nothing**, and that is a scope decision rather than
unfinished work (manager ruling, 2026-10-23):

- a Chatwoot webhook is a server-to-server call with **no agent token**, and #556 rules out a service-account
  read here — so any customer lookup would need a principal this route does not have, and inventing one is the
  thing the ruling forbids;
- a conversation → customer link is a **table this service does not own**. The resolution happens on the
  dashboard request instead, which does carry the agent's token.

A link table and a principal are a later phase. The route answers **202**, not 200, because it is accepted and
deliberately acted on by nobody, and the body says `persisted: false` so a caller cannot mistake it.

**Replay safety** has two guards, both with limits worth stating. _Freshness_: the payload's own `created_at`
must be within 5 minutes, so it depends on Chatwoot's clock and ours being roughly aligned — hence the wide
window — and a payload with **no** usable timestamp is rejected rather than waved through, because for that
delivery the guard would not exist at all. _Seen-once_: an in-memory LRU of recent (conversation, event,
timestamp) digests, which a restart forgets and a second instance would not share — the same honest limit as
the ops rate limiter. It is enough here precisely because the stub has no side effect to replay: nothing is
written and nothing is sent. The day it does something stateful, that guard has to become a table.

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
- `consent.test.ts` — the gate (pure) over every outcome, and the two projection reads on a throwaway
  database: the shape the core actually writes, another purpose not granting ours, a malformed block reading
  as "never answered", per-store isolation, and that the read path writes nothing.
- `cdp/adapter/adapter.test.ts` — the memory adapter, and RudderStack against an injected fetch (request
  shape, Basic auth, the regulation call, the refusal to suppress without a control-plane token, and that the
  write key never reaches a body, an error or the object).
- `cdp/consumer.test.ts` — the decision path on a throwaway database (consent honoured over the payload's
  snapshot, guest dropped, erasure suppressed even with the row gone, per-store consent) plus its own live
  block.
- `crm/rollup.test.ts` — 20 cases over placed / cancelled / refunded: exclusions, pending and failed refunds,
  over-refunds, the newest-order date, bigint strings, zero-decimal currencies, mixed currencies, and that the
  same rows always give the same answer.
- `crm/adapter/adapter.test.ts` — the memory adapter, and Twenty against an injected fetch: create vs update
  by external id, a custom field name, idempotent remove, and that the key never reaches a body, a URL, an
  error or the object.
- `crm/admin-api.test.ts` — the reader: the bearer header, a token asked for per call, 404 as `null`, 401/403
  retryable, and no response body in any error.
- `crm/consumer.test.ts` — the decision path on a throwaway database: the rollup end to end, idempotency on
  redelivery, no consent meaning no PII fetch at all, erasure removing with the row already gone, the log-line
  PII sweep — plus its own live block.
- `support/server.test.ts` — the whole 401 / 403 / 200 matrix end to end on a throwaway database: no token,
  unknown subject, disabled staff user, not-support-for-this-store, another store, OpenFGA down (503), and the
  200 — plus that the agent's own header reached every read, that a refused gate made no call, the `no-store`
  header, the log-line PII sweep, and the webhook's 202 / 401 / 409 / 405 / 413 / 503.
- `support/chatwoot.test.ts` — signature (missing, wrong, tampered, wrong length), the payload shape, the
  freshness window in both directions, replay including a cosmetically re-serialised body, the bounded memory,
  and that the address is hashed and never returned raw.
- `support/context.test.ts` — the summary, and the shapes the contract allows: `total` as a number or a
  bigint string, absent embedded arrays, a missing detail noted rather than dropped, and a 401/403 re-thrown.
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

### The live blocks run locally, not in CI

Every `*/consumer.test.ts` has a live block against the local Redpanda, and **CI has no broker for them**, so
there they skip with a printed reason and the suite is the unit and database tests only. What that means
honestly: the dedupe-off-the-real-bus and dead-letter guarantees are proven on a developer machine before a
push and are **not** re-proven on every CI run. They are not skipped silently — the reason is printed, and a
broker-up run is part of finishing a task here (and `ONE WINDOW MEASURES AT A TIME`, so it is asked for).
Making CI run them would need a broker service in the workflow, which is window 5's file and a REQUEST, not
something this package can arrange.

## What is not here (and where it is tracked)

- **A real Slack post.** Blocked on the owner's workspace; on the launch checklist.
- **A real CDP call.** Blocked on the owner's RudderStack account; the consumer ships disabled
  (`ENGAGEMENT_CDP_ENABLED=0`) and the live use is on the launch checklist.
- **A real CRM call, and a real service-account token.** Blocked on the owner's Twenty instance and on #565;
  both are launch-checklist items, and the consumer ships disabled (`ENGAGEMENT_CRM_ENABLED=0`).
- **A real Chatwoot instance**, and therefore a real signed delivery: the HMAC, freshness and replay guards are
  tested against generated signatures only. On the launch checklist.
- **A conversation → customer link that persists**, and the principal a webhook would need to resolve one:
  deliberately out of this phase (see "The Chatwoot webhook, and its documented limit").
- SMS/WhatsApp (Twilio), Novu and Klaviyo flows — deferred until accounts exist (manager decision on #553).
- The returns portal and refund limits by role — a later wave across core, auth, storefront and admin.
- This service's `COPY` lines in the Dockerfiles: the manager lands them as an integration commit on the 16.1
  head (a new workspace package reddens `app images` until every Dockerfile has them).
