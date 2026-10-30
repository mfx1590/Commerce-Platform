# @platform/engagement

## Purpose

The engagement service (window 16, Phase 4). Today: **ops alerts** (#553) — group `engagement.ops` over
`payment.failed`, `refund.failed`, `return.requested` plus a dead-letter depth watch, through a transport
(`dev` JSON-lines sink or a Slack webhook) — and the **CDP** (#554) — group `engagement.cdp`, 9 mapped
topics driven by `data/cdp/tracking-plan.json`, consent-gated off the `customer.consent` projection, with a
RudderStack adapter and an in-memory one — **CRM sync** (#555) — group `engagement.crm`, one contact per
customer per store with a recomputed order/LTV rollup, PII from the core Admin API with this service's own
principal (#565), Twenty and in-memory adapters — and the **support-context API** (#556, `src/support/`): one
HTTP server, the agent's OWN token, plus a Chatwoot webhook stub. README.md has the design and the
guarantees.

## Owner

window 16 (engagement), branch prefix `engagement/`. Owned paths: `apps/engagement/**`, `apps/support/**`,
`data/cdp/**`. **`apps/notifications` is window 17's** — it is the model for transports and exactly-once, never
a file to edit; a change there is a `REQUEST:` to window 17.

## Run / test

- `pnpm --filter @platform/engagement dev` — consumer + DLQ poll against `.env` (DB rows on 127.0.0.1)
- `pnpm --filter @platform/engagement start` / `once` (one DLQ poll, prints a report, exits)
- `pnpm --filter @platform/engagement drain` (`--drain`, #594) — the one-shot measurement: every enabled
  consumer from the beginning of its topics until the bus is quiet, then one report. Pair it with a FRESH
  group per module (`ENGAGEMENT_{OPS,CDP,CRM}_GROUP_ID`) so it never moves the live group's offsets. `--once`
  is still the DLQ poll and must stay that way — `pnpm once` and the runbooks mean it.
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
- `src/consent.ts` — the projection reads and the gate. SERVICE-WIDE (the CDP and the CRM share one rule), and the only file in either path that touches a database
- `src/cdp/consumer.ts` — group `engagement.cdp`, the two clients, post-then-mark, drop logging
- `src/cdp/adapter/` — `memory.ts` (runs today), `rudderstack.ts` (data plane + regulations)
- `src/crm/rollup.ts` — PURE orders/LTV rollup; recomputed, never accumulated (idempotency)
- `src/crm/read.ts` — the order and refund rows the rollup needs; no PII read from the tables
- `src/crm/admin-api.ts` — the ONLY PII read, via an injected `TokenProvider` (#565)
- `src/crm/consumer.ts` — group `engagement.crm`; consent before PII, erasure before everything
- `src/crm/adapter/` — `memory.ts` (runs today), `twenty.ts` (upsert by our id, never by e-mail)
- `src/support/auth.ts` — the two gates: staff token + `staff_user` row, then `support` on the store via FGA
- `src/support/admin-api.ts` — the three reads, each with the AGENT's header; nothing cached. Response types
  come from `@platform/contracts/admin`, NEVER hand-written: `listOrders` is a `Page` of `items`, `total` is
  `Money`, `getCustomer`/`getOrder` have no envelope
- `src/support/context.ts` — pure normalisation + the glance summary; a gap becomes a `note`
- `src/support/chatwoot.ts` — HMAC, freshness, seen-once; hashes the address on arrival
- `src/support/server.ts` — node:http, three routes, `cache-control: no-store`
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
- **`ENGAGEMENT_CRM_MOCK_TOKEN` is a dev stand-in for the `crm-sync` principal (#565); never in production.**
  It feeds `mockTokenProvider` so the CRM path can be measured end to end on the dev stack (#594), where no
  service principal exists: with the core on `CORE_DEV_TOKENS=1` a `dev:<subject>` token lets consent → PII
  fetch → rollup → upsert actually run. It is a STAFF subject, so the rule above — CRM uses this service's
  own principal, never a human's token — still stands and this is its one dev exception. `resolveConfig`
  refuses the value in production whether or not the CRM is enabled, and a test pins both that refusal and
  the mock provider's own; label it as a stand-in wherever it appears in a report.
- **The support API uses the AGENT's own token, never a service principal** (#556). Authenticate, then check
  `support` on the store server-side, THEN read — and forward the agent's header so the core checks them too.
  OpenFGA unreachable is 503, not 403.
- Nothing from a support answer is cached or stored, and every response is `cache-control: no-store`: it is
  personal data and the agent's permission is only true at the moment the core says so.
- A support log line carries ids, the store code and counts — never a name, address, e-mail or tracking number.
- A customer of another store gets the SAME 404 as a non-existent one: the route must not reveal that an id
  exists elsewhere.
- The Chatwoot webhook resolves nothing and persists nothing, by ruling: it has no agent token and owns no
  table. Do not add a lookup or a service principal to it — that is a later phase.
- The webhook signature is a real **HMAC** (`createHmac('sha256', secret)`), never `sha256(secret + body)`.
  Chatwoot's documented header format is UNCONFIRMED; both bare-hex and `sha256=` are accepted and the exact
  shape is a launch-checklist check.
- **Validate every path id as a uuid in the route before calling anything** (404, not 400 — malformed and
  absent must look the same), and `encodeURIComponent` every path segment in the reader. An unvalidated id in
  a path can reach another Admin API route with the agent's own token.
- Known limit, recorded not fixed: the store lookup precedes the permission check, so store codes are
  enumerable by an authenticated staff user.
- **CDP consent is READ-ONLY, from the `customer.consent` PROJECTION, at processing time** (manager ruling
  2026-10-23). Never the `customer_consent` ledger rows (window 13's semantics — a `REQUEST:` if the
  projection is not enough), never a write to either, never an API hop. Ignore the `marketing_consent` field
  in the `customer.created` / `customer.updated` payloads: it is a snapshot, the projection is the truth.
- The CDP consumer needs TWO clients: the organization one for the marks (`consumer_processed` is
  `organization_only`), and a store-scoped one per event for the consent read (least privilege — consent is
  never propagated across stores).
- **Per-store config keys are normalised the same way on BOTH sides** (#586): `storeEnvKey` writes them and
  reads them, in `consent-mode.ts`. A key stored raw and looked up normalised is what made
  `ENGAGEMENT_CDP_CONSENT_MODE_brand_a` parse, validate and then apply to nothing. Two spellings of one store
  that disagree fail the boot; an override naming no store is refused by `main()` BEFORE a single consumer
  starts, from one warmed `StoreCodes` it then hands to the CDP consumer (`resolveConfig` has no database, so
  the check cannot live there, and it is skipped entirely while the CDP is disabled).
- **A startup refusal must stop the PROCESS, not just set an exit code** (#590 review, which found exactly
  that bug): anything already started keeps the event loop alive, so `process.exitCode` alone is a no-op and
  the service stays up with a configuration it refused. Validate before starting, unwind what started on a
  failure, write the crash line synchronously, and `process.exit(…)`.
- **A configuration refusal is a `ConfigRefusedError` and exits 2; everything else exits 1** (#599). Every
  refusal in `config.ts` is one, and `ConsentModeConfigError` extends it. A supervisor that restarts on a
  crash must not restart on an environment that has already been refused — it will be refused again, and the
  loop buries the message.
- **A `ConfigRefusedError`'s MESSAGE is printed by the crash line**, the one exception to "the class only".
  It holds only while those messages are built from env variable NAMES and from values this repository chose
  — a mode, an adapter, a group id, a port. **Never echo the value of a credential-bearing variable**
  (`DATABASE_URL_APP`, `SLACK_OPS_WEBHOOK_URL`, `TWENTY_API_KEY`, `RUDDERSTACK_WRITE_KEY`,
  `CHATWOOT_WEBHOOK_SECRET`, `ENGAGEMENT_CRM_MOCK_TOKEN`) and never a payload or an address. Keep the test
  that pins every consent-mode failure to this class.
- **CDP consent mode (#576, owner decision 2026-10-23):** `analytics` is the DEFAULT — track and identify run
  without `marketing_email`, and a guest is tracked under their `email_hash`. `strict` is #554's behaviour. The
  mode **resolves PER STORE** (`ENGAGEMENT_CDP_CONSENT_MODE` plus `..._<STORE_CODE>`), is resolved per event
  from the store the event names, and goes on the per-event log line. An unknown value fails the boot; a
  missing mode defaults to `strict`. Never invent a consent purpose.
- An **erased** customer is never sent in either mode, and `customer.erased` is ungated in both and carries
  BOTH ids when known (the hash arrives with #580's v2; send it when present).
- **A per-store consent-mode value that is SET BUT EMPTY is refused** (#644, Fable re-review, medium): it
  used to fall back to the global mode, so an unresolved template tracked a store the operator believed was
  strict. A missing variable is a default; an empty one is a refusal. **An override whose key matches TWO known store
  codes also refuses the boot**, naming the pair — it cannot say which store it means, and a privacy switch
  is never guessed at. NARROWED to keys in use (manager decision): without an override a collision changes
  nothing, and store codes come from the onboarding UI, so a refuse-always form would let one store creation
  stop the CDP for every store. Both refusals are `ConsentModeConfigError`, exit 2, and both directions are
  tested — the ambiguous override refuses, a collision nobody addresses boots.
- Two residual behaviours are DOCUMENTED, not fixed (#644, both need a missing row): an unresolved store
  code falls back to its uuid and therefore to the GLOBAL mode (the fallback is #553's rule — never drop an
  alert because a lookup failed — and the effective mode is on every log line); and a vanished customer row
  in `analytics` mode is tracked under the payload's hash, because at the gate it is identical to a guest —
  the consumer normalises a not-found id to null before gating. Changing the second one means plumbing "the
  payload named a customer" through to the gate, with its own test. Do not change either quietly.
- **The CDP mode must never reach CRM sync**, which stays consent-gated because it fetches and stores PII. A
  test pins it.
- `identify` carries ids only — `customer_id`, `email_hash`, store code. Not `status`, not `customer_group_id`
  (a marketing segment id).
- **No raw e-mail address is ever read from one of our TABLES or from an EVENT, and none is read to fill a
  missing `email_hash`** (manager ruling 2026-10-24, refusing exactly that fix for the guest-lifecycle gap;
  the way to get a hash is a CONTRACT CHANGE on the event — #584). An address exists in this service in
  exactly three places, all explicit, all from the Admin API or the caller rather than our own rows (#586
  review corrected an earlier version of this rule, which claimed the CRM path was the only one):
  - **CRM sync (#555)** fetches a name and an e-mail for the contact it is about to write, holds them in a
    `CrmContact` on the way to the adapter, and keeps nothing;
  - **support context (#556)** reads the customer and RETURNS the address to the agent — that IS the feature:
    an agent answering a ticket reads the person's own record, with the agent's own token, and nothing is
    cached or stored;
  - the **Chatwoot webhook** is handed one by Chatwoot and hashes it on arrival (`hashEmail`), so the raw
    value never leaves `receive()`.
    Everywhere else a hash is the only form an address takes. The CDP and ops paths read no address at all, and
    no path may start reading one from a table of ours or from an event payload. A log line, an alert, an error
    and a dead letter never carry one in any module, including the three above.
- **A one-off run gets a FRESH group, never the live one** (#594): `ENGAGEMENT_*_GROUP_ID` plus
  `fromBeginning`, which is what makes a new group see history instead of waiting for the next message. A
  group id must match `consumer_processed.group_id`'s CHECK, validated at the boot.
- **`buildConsumers` in `main.ts` is the ONLY place a consumer is constructed, and therefore the only place a
  group id is chosen** (#599). Both modes call it; the only differences they may pass are `fromBeginning` and
  the drain's per-batch hook. The bug that made this a rule: the drain passed `config.groups` and the
  long-running path built them inline without a group id, while `dlq.groups` had started defaulting to
  `config.groups` — so an override moved the WATCH and left the CONSUMER behind, and the watch reported "all
  clear" about a queue nobody was filling. Two readers of one value with different defaults. If you add a
  consumer, add it there.
- **Every group this process runs must be watched; more is fine, fewer is refused** (#599). `resolveConfig`
  throws when an explicit `ENGAGEMENT_DLQ_GROUPS` omits a running group — the one way left to split them.
- **A configuration refusal is a `ConfigRefusedError` and exits 2**, not 1 (#599): a supervisor that restarts
  on a crash must not restart on an environment already refused, and its message IS printed because this
  repository builds it from variable names and values it chose. `ConsentModeConfigError` extends it. Never
  put a payload, a secret or anything a customer typed into one of those messages.
- The drain's counts come from the log lines the consumers already emit, with each consumer's own counters
  printed beside them. Keep both: they are two paths to one answer, and a disagreement means the report is
  wrong.
- A new topic in `packages/events` must be added to `data/cdp/tracking-plan.json` as mapped or unmapped with a
  reason; the suite fails until it is.
- Never touch a Dockerfile: the manager lands this service's `COPY` lines as an integration commit.
- Update README.md and CHANGELOG.md with every change, and the memory file before every commit.
