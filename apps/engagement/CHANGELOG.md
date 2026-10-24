# @platform/engagement

## 0.5.1 — 2026-10-24 (#586, task 16.2b)

The #585 review's follow-up: a per-store consent-mode override that is silently ignored is now impossible.
This had to land before any store or region is set to `strict`.

- **The override KEY is normalised on both sides.** `ENGAGEMENT_CDP_CONSENT_MODE_<STORE>` was stored under the
  RAW env suffix and looked up under the normalised store key, so `..._brand_a` (or any other spelling)
  parsed, validated — and then matched nothing, leaving that store on `analytics` while the configuration
  said `strict`. That is the exact failure 0.5.0's boot-failure rule promised not to have: loud about a bad
  value, silent about a bad key. `storeEnvKey` now writes the key and reads it, in one place.
- **Two spellings of one store that DISAGREE fail the boot** (`..._BRAND_A=strict` with
  `..._brand-a=analytics`): there is no safe answer, and letting whichever `Object.entries` yielded last win
  is how a region ends up on the open mode by accident. Two that agree are allowed — nothing to get wrong.
- **An override that names no store fails `createCdpConsumer.start()`**, immediately after
  `storeCodes.warm()`, naming the variable and listing the store codes that do exist. It cannot be checked
  in `resolveConfig`, which has no database and cannot tell a typo from a store it has not heard of — so
  `resolveConfig` keeps such a key rather than guessing, and a test pins that. ACCEPTED limit, commented
  where it runs: the CDP ships off, so with `ENGAGEMENT_CDP_ENABLED=0` there is no store list and no boot to
  fail — a consumer that is not running applies no mode to anything.
- **`src/consent-mode.ts` is a new module** holding the env contract (`storeEnvKey`, `parseConsentMode`,
  `readConsentModeOverrides`, `assertConsentModeOverridesKnown`). It is separate from `config.ts` for a
  structural reason, not for tidiness: `config.ts` imports the three consumers for `KNOWN_GROUPS`, so a
  consumer cannot import it back without a cycle. The alternative — a second copy of the normalisation
  inside the consumer — is the bug class this release fixes. `config.ts` delegates and re-exports
  `storeEnvKey`, so its public surface is unchanged.
- **`StoreCodes.codes()`** returns the codes loaded so far (the whole organization after `warm()`), with a
  test that it really answers the seeded codes: a `codes()` that answered nothing would make the check
  vacuous and call every override unknown.
- **`apps/engagement/CLAUDE.md`'s "no raw e-mail" rule named one exception and there are three.** It now
  names CRM sync (#555), support context (#556 — which reads AND returns the address to the agent, because
  that is the feature) and the Chatwoot webhook (handed one, hashes it on arrival). What the rule still
  forbids is stated separately and unchanged: no address from one of our tables or from an event payload, and
  none read to fill a missing `email_hash` (#584).
- **The erasure wording was wrong in two places.** `data/cdp/README.md` and the `cdp/consumer.ts` comment
  said the core deletes the customer row. It KEEPS it with `status = 'erased'`, listable and readable, with
  every personal field already replaced — so the reason v1's missing `email_hash` cannot be recovered is that
  the ADDRESS is gone, not the row. #584 is now cited in the guest-lifecycle section with its decision.
- **A test that proved nothing now proves the claim.** The renamed 404-equivalence test built two identical
  `getCustomer: async () => null` fakes, so it only showed that one fake is deterministic. The second reader
  is now store-aware — it owns brand-B's customer and answers `null` under brand-a, as a row invisible to
  that store's read does — plus an assertion that the same reader DOES find them under their own store.
- Tests: **400 passing, 9 live skipped** with the broker offline (was 385/9) — config 61, CDP consumer 32
  (29 + 3 live), support server 30, plus the rest.

## 0.5.0 — 2026-10-24 (#576, task 16.2a)

The CDP consent mode: analytics tracking and pseudonymous guests, allowed by default, switchable per store.

- **The owner answered #554's two open questions on 2026-10-23: both allowed.** Analytics tracking of our own
  commerce events does not need a marketing consent, and a guest may be tracked under their `email_hash`. The
  lawyer-pending section of `data/cdp/README.md` is replaced by the decision, a modes table and the one-line
  switch back.
- **`ENGAGEMENT_CDP_CONSENT_MODE`** = `analytics` (default) | `strict`, **resolved PER STORE** through
  `ENGAGEMENT_CDP_CONSENT_MODE_<STORE_CODE>` (the `NOTIFICATIONS_<STORE>_<FIELD>` shape). Each brand is one
  market, so a region's rules are a config change: `ENGAGEMENT_CDP_CONSENT_MODE_BRAND_A=strict`. The mode is
  resolved **per event** from the store the event names and goes on every per-event log line as
  `consent_mode`, so a quiet CDP is explainable per store. Every per-store value is parsed at STARTUP, so a
  typo fails the boot instead of silently applying the global default to one region months later — and an
  unknown value throws rather than falling back to the open mode. A gate called with no mode defaults to
  `strict`.
- **`analytics` does not relax two things**, because neither is about consent: an **erased** customer is never
  sent in either mode (the erasure told every consumer to delete its copies), and a vanished order or customer
  row is still reported as such.
- **`identify` carries ids only** — `customer_id`, `email_hash`, store code — in both modes. `status` and
  `customer_group_id` are gone: `status` is not an id, and a customer group is a marketing SEGMENT id, which is
  the kind of trait an identify must not carry. `data/cdp/tracking-plan.json` is version 2 to match.
- **`customer.erased` carries BOTH ids when both are known**, so a hash-keyed profile is suppressed alongside
  the `customer_id` one. v1 has no hash; **CONTRACT CHANGE #580** adds it in a v2, and the suppression already
  sends it when present — so it starts working the day v2 lands with no change here.
- **CRM sync is untouched** and stays consent-gated in every mode, because it fetches and stores PII in a
  third-party system. Two tests assert the CDP mode cannot reach it, including a structural one on the
  handler's own deps.
- **A known asymmetry, recorded rather than quietly worked around:** of the six mapped commerce topics only
  `order.placed` carries an `email_hash`, so a GUEST's later `payment.captured` / `shipment.shipped` have no
  identity and are dropped even in `analytics`. A guest's _Order Completed_ therefore reaches the CDP while
  their _Order Shipped_ does not. Closing it would mean hashing the order row's raw e-mail inside the CDP path,
  which widens what this service reads; tests pin the behaviour both ways.
- The #573 nit: `context.ts` no longer claims a core 403 "becomes" a 404. A customer of another store reaches
  the same 404 because the core's store-scoped read cannot SEE them, not because anything is mapped; a core
  401/403 means our gate and the core disagree and is passed through, because masking it would hide a real
  misconfiguration. The test is renamed to what it proves.
- **The #585 queue failure, once #583 put `customer.erased` v2 on main.** The "suppresses by `customer_id` alone" test reused the shared erasure fixture, which carries an `email_hash` since #583 — so it asserted v1 behaviour on a v2 payload and received the hash where it expected none. It now builds a GENUINE v1 envelope (version 1, no `email_hash`, validated against the frozen v1 schema) through an explicit `version` on the test's envelope helper, and guards both facts before asserting. The v2 test no longer mutates a hash onto a payload that already has one.
- Tests: **385 passing, 9 live skipped** with the broker offline — consent 37, config 41, CDP consumer 29
  (26 + 3 live), plus the rest.

## 0.4.0 — 2026-10-23 (#556, task 16.4)

The support-context API and the Chatwoot webhook stub.

- **One HTTP server** (`node:http`, no framework): `GET /health`, `GET /support/customers/:customerId/context`
  and `POST /webhooks/chatwoot`. Off unless `ENGAGEMENT_SUPPORT_ENABLED=1`.
- **The agent's OWN token does the reading**, not a service principal — the deliberate difference from CRM
  sync. Two gates before any read: a staff-realm JWT plus an active `staff_user` row (401), then `support` on
  `store:<id>` through OpenFGA server-side (403). The agent's header is then forwarded to every Admin API call
  so the core checks the same agent again; a test asserts a refused gate makes no call at all. OpenFGA
  unreachable answers **503, not 403** — the agent is not forbidden, we cannot tell.
- **Three read-only operations**, all already in the contract: `getCustomer` (`support`), `listOrders` and
  `getOrder` (`viewer`, which `support` implies). `getOrder` embeds payments, refunds, shipments and returns,
  so the history is one list call plus one detail call per order. The `customer_id` filter on `listOrders` is
  CONTRACT CHANGE #569 (accepted, Admin API 0.4.24); `q=<e-mail>` was rejected because it puts an address in a
  URL and is a search rather than a key.
- **Nothing is cached or stored**, and every response carries `cache-control: no-store`: a cache would be both
  a stale permission and a copy of personal data. Log lines carry ids, the store code and counts only.
- **A partial answer is never silently partial**: an order whose detail cannot be read still appears from its
  summary with a line in `notes`; a 401/403 from the core is re-thrown rather than noted. A customer of another
  store gets the same 404 as one who does not exist.
- **The Chatwoot webhook stub** verifies the HMAC, hashes the contact's address on arrival and returns the
  conversation → `email_hash` link. It resolves nothing and persists nothing, by ruling: it has no agent token
  and owns no link table, so it answers 202 with `persisted: false`. Replay safety is a 5-minute freshness
  window (a payload with no usable timestamp is rejected, not waved through) plus an in-memory seen-once LRU,
  whose limits are documented — it is enough because the stub has no side effect to replay.
- Tests: **349 passing, 9 live skipped** with the broker offline — support server 30, Chatwoot 27, support
  reader 22, support context 17, plus the #553/#554/#555 suites and the config tests.

### The three #573 review fixes

- **The reader did not match the contract, and would have returned nothing against the real core.** It read
  `body.orders` where `listOrders` answers a `Page` of `items`, and treated `total` as a scalar with a
  top-level `currency` where `OrderSummary.total` is `Money { amount_minor, currency }`. Every customer would
  have shown zero orders and an empty currency. The three responses are now typed from
  `@platform/contracts/admin` (`Customer` and `Order` come back directly, with no envelope), `context.ts` reads
  `Money` and the embedded `Payment` / `Refund` / `Shipment` / `Return` shapes, and **every support fixture is
  typed from the contract's own schemas** — so the next drift is a compile error, not a silent empty answer.
  A test also pins the old wrong shape: a body keyed `orders` yields nothing.
- **Path ids are validated as uuids in the route before any call** (404, so malformed and absent are
  indistinguishable), and the reader `encodeURIComponent`s every segment. Tests cover a malformed id and an
  encoded `%2F..%2F` traversal, and assert neither reaches the core.
- **The webhook signature is now a real HMAC** (`createHmac('sha256', secret)`), not the keyed hash
  `sha256(secret + '.' + body)` the first version computed; a bare hex digest or a `sha256=` prefix is
  accepted, and a test asserts the old value is rejected. Chatwoot's own header format could not be confirmed
  and is called out as unverified in the README — a launch-checklist check, not an assumption.

Also, from the same review: the per-store 403 test now asserts the permission was asked for
`store:<brand-b id>` specifically (the old fake returned a flat boolean and would have passed a `store:*`
check); a core 403 for a foreign customer is proven to produce the byte-identical 404 as a missing one; the
`consent.ts` comment no longer says a `GateIdentity` is identical to a `GateIdentity`; and the store-code
enumeration limit is recorded in the README.

### The three #568 review nits, folded in here:

- a Twenty **DELETE that answers 404 after a successful lookup counts as already gone**, not a failure: the
  lookup found the person, something deleted it before our DELETE landed, and the outcome we wanted has
  happened. A 404 on the PATCH path is instead marked **retryable**, so the retry's lookup finds nothing and
  POSTs; a 404 on a POST stays fatal, because that is a wrong base URL and not a race.
- the read-only test is now a **checksum over every row** of `order`, `refund` and `customer` rather than
  counts plus `max(updated_at)`, and it asserts the checksum notices a change — so the "nothing changed" claim
  is as strong as its wording.
- `by_currency` and `mixed_currency` **stop at the `CrmContact` boundary**, which is now documented on the type
  and in the README: a CRM person has one revenue field, so for a mixed-currency customer `ordersCount` (all
  currencies) and `netRevenueMinor` (the store default) disagree in scope, and the consumer's log line is the
  only place that says so.

## 0.3.0 — 2026-10-23 (#555, task 16.3)

CRM sync: one contact per customer per store, with a recomputed order/LTV rollup.

- **Consumer group `engagement.crm`** over `customer.created`, `customer.updated`, `customer.erased`,
  `order.placed`, `order.cancelled` and `refund.issued`. Same SDK, same shared marks, same two clients and the
  same post-then-mark as #553/#554.
- **The rollup is RECOMPUTED, not accumulated** (`crm/rollup.ts`, pure, 20 unit tests): `+1 order` against a
  stored counter cannot tell a redelivery from a second order, and the bus is at-least-once and replayable.
  Recomputing from the customer's own rows makes the sync idempotent by construction, and a test proves the
  same event handled twice leaves an identical contact. A cancelled order is not counted at all; only a
  `succeeded` refund reduces revenue; a refund against a cancelled order is not subtracted; net is floored at
  zero with the unclamped figures kept; currencies are never summed, and a customer with orders in another
  currency sets `mixed_currency`.
- **Upsert by OUR customer id, never by e-mail** (`crm/adapter/twenty.ts`): find the person whose external-id
  field equals `customer.id`, then PATCH or POST. An address changes and two people share one. An unreadable
  lookup fails rather than falling through to a create that would duplicate the person; `remove` is idempotent.
- **PII from the core Admin API with this service's own principal**, through an injected `TokenProvider` so
  #555 is built, tested and merged before the `crm-sync` service account exists (#565, accepted and routed to
  window 2). Two read-only operations, `support` on the store. `client_credentials` throws rather than falling
  back to the mock, and the mock is refused in production. A 404 is an answer, 401/403 are retryable (an
  unseeded principal is a deploy-order problem), and no response body ever reaches an error.
- **Consent gates the whole contact**, from the same projection as the CDP and checked BEFORE any PII is
  fetched — a test asserts the reader is never called for a customer without consent. `customer.erased`
  deletes before anything is read and works when the customer row is already gone.
- **No PII in a log line**: the customer id, store code, counts and reason codes only, swept by a test.
- `ENGAGEMENT_CRM_ENABLED` defaults to `0`; `KNOWN_GROUPS` now includes `engagement.crm`, so the DLQ watch
  covers it by default.
- The rollup's reads are read-only through a store-scoped client on the event's own store, with two tests
  pinning it: a store-B order carrying a store-A customer's id contributes nothing (RLS, not our filter), and
  the whole path leaves every order, refund and customer row byte-identical.
- **The three #564 review nits:** the `messageId` wording in `cdp/consumer.ts` now says what it is — the
  envelope's `event_id`, which IS the outbox id by contract (ADR 0003 item 2) — rather than implying a second
  source; the README states that the live broker blocks do not run in CI and what that costs; and the PR-body
  test counts are taken from an actual run this time.
- Tests: **243 passing, 9 live skipped** with the broker offline — rollup 20, CRM consumer 24 (21 + 3 live),
  CRM adapters 17, Admin API reader 13, plus the #553/#554 suites and the config tests.

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
