# @platform/engagement

## 0.7.0 — 2026-10-30 (#646, the Fable re-reviews of #598 and #613)

CRM sync can run on its own principal, and a measurement can no longer disturb what it measures.

- **(medium) `client_credentials` is implemented** (`src/crm/token.ts`): the real `crm-sync` confidential
  service account (#565, shipped by #626/#635), exchanged at the staff realm's token endpoint. Until now it
  threw, `mock` was the default, and every refusal was keyed on `NODE_ENV === 'production'` — which itself
  defaults to `development` — so a staging or container deploy with `NODE_ENV` unset ran the CRM on the dev
  stand-in and dead-lettered every consented event against the real core.
  The secret and the token **never leave that module**: nothing in it logs, a failure carries the HTTP status
  plus Keycloak's short `error` code and nothing else (not `error_description`, which echoes input — a test
  puts the secret in that field and asserts it does not reach the message), and an unreachable identity
  provider is reported without the error that would carry the request. A token failure is **retryable**,
  because a wrong secret and a Keycloak restart are indistinguishable from here and the consumer's retries
  plus the DLQ are the right place for that. One token is cached until shortly before expiry, and the
  **in-flight exchange is shared**, so a batch of 50 events does one exchange rather than 50.
- **(medium) `mock` is an explicit opt-in.** `ENGAGEMENT_CRM_TOKEN_PROVIDER` has no default when the CRM is
  enabled: choosing a principal is not a thing to default, because the wrong one reaches the real core.
  `client_credentials` also refuses a missing `KEYCLOAK_URL` or `CRM_SYNC_CLIENT_SECRET` at the boot rather
  than at the first consented event.
- **(medium) `--drain` refuses a live consumer group.** It reads from the beginning and commits under
  whatever group it joins, so by omission it rebalanced the running consumer, moved its offsets and reported
  the live dead-letter queue as its own. It now exits 2, naming the groups and the way out, and it checks
  only the modules that would actually run (the #644 lesson: refuse what bites).
- **(minor) A drain says whether its result is clean**, in the report and in the exit code: **3** for dead
  letters, an unreadable DLQ (`-1`) or `max_run`. It always exited 0 before, so a scripted gate read a pass
  over a report full of findings. 2 stays "configuration refused", 1 "the process failed".
- **(minor) A refusal outside `config.ts` is a `ConfigRefusedError` too**: `buildTokenProvider`'s remaining
  guard exits 2 with its message instead of 1 with the message dropped.
- **(minor) An unreadable dead-letter queue says `unreadable: true`** in the watch's log line. `depth: 0`
  alone read as "nothing in the queue", which is the opposite of what happened.
- **(docs) `apps/engagement/CLAUDE.md` drift fixed**: `ENGAGEMENT_DLQ_GROUPS` defaults to the groups the
  process runs (since #613, not `KNOWN_GROUPS`), the duplicated exit-2 rule is one rule again, and "a missing
  mode defaults to `strict`" now says what it means — a CONSUMER given no resolver defaults to strict, which
  is a library default for a forgetful caller, not an operator-facing one.
- **From the #654 review, before the queue:** in production a `KEYCLOAK_URL` that is not `https://` is
  refused (exit 2). The client secret travels in the token request body, so an `http://` endpoint hands it to
  the network before Keycloak can refuse anything — and a misconfigured URL is exactly the case where that
  happens. The dev stack's `http://localhost:8180` stays allowed outside production.
- **From the same review: token failures are a `CrmTokenError`**, retryable as before but named. The DLQ
  carries the error CLASS and no payload, so the class IS the diagnosis: `CrmTokenError` means this service
  could not authenticate (a wrong secret, a disabled client, Keycloak down) while `CrmError` means the Admin
  API refused or failed, and those send an operator to different places.
- Tests: **478 passing / 9 live skipped** offline (was 453/9) — the token provider 10, config 100+, drain 11,
  boot 5.

## 0.6.2 — 2026-10-30 (#644, the Fable re-review of #585/#590)

Two refusals and two documented limits. The re-review's verdict was FINDINGS with one medium.

- **(medium) An empty per-store consent-mode value is refused.** `parseConsentMode` returns its fallback on
  a blank value and `readConsentModeOverrides` passed the GLOBAL mode as that fallback, so
  `ENGAGEMENT_CDP_CONSENT_MODE_BRAND_A=` — an unresolved secret-manager template, a stray `=` in a compose
  file — booted cleanly and tracked brand-a under `analytics` while the operator believed it was strict. A
  MISSING variable is a default; a per-store variable that is set is something somebody wrote, so an empty
  one is a `ConsentModeConfigError` (exit 2) naming the variable. The global default may still be absent or
  blank, which is what a default is for, and a test pins that too.
  **A test that asserted the old fallback is reversed**, with a note: it passed because the global happened
  to be `strict` in that case, which is exactly what hid the defect.
- **(minor) An override that cannot say which store it means refuses the boot.** `brand-a` and `brand_a`
  are both `BRAND_A`, and `store.code` is unique per organization only as text, so both can exist and one
  override would silently apply to both. An unaddressable privacy switch must not be guessed at: the boot
  refuses, naming the pair, and reports every ambiguous override at once.
  **It refuses only when an override USES the ambiguous key** (manager decision on review): without one the
  collision changes nothing — both stores take the global mode — and store codes are created from the
  onboarding UI, so a refuse-always form would let a single store creation stop the CDP for every store.
  Both directions are tested: the ambiguous override refuses, a collision nobody addresses boots.
- **(minor, latent) A vanished customer row in `analytics` mode is tracked under the payload's hash** — as a
  guest, which is what it is indistinguishable from at the gate, because the consumer normalises a not-found
  customer's id to null before gating. **Pinned by a test** rather than changed: it is unreachable today (the
  core keeps an erased customer with `status = 'erased'`, refused in both modes), and changing it needs "the
  payload named a customer" plumbed through to the gate, which is a follow-up with its own test, not a line
  here.
- **(minor) A store code that cannot be resolved falls back to its uuid**, so that store resolves to the
  GLOBAL mode. Documented in the README: the fallback is #553's rule (never drop an alert because a lookup
  failed), dropping the event would lose data for a transient failure, and the effective mode is on every
  per-event log line, so the case is visible rather than silent.
- Tests: **453 passing / 9 live skipped** offline (was 445/9) — config 95, CDP consumer 31 + 3 live, boot 4.

## 0.6.1 — 2026-10-25 (#599, Phase 5 wave 1)

A group override moved the DLQ watch and left the consumer behind. One builder now chooses every group.

- **The bug.** `--drain` passed `config.groups` to the consumers; the long-running path built them inline
  with no group id, while `config.dlq.groups` had started defaulting to `config.groups` (0.6.0). So
  `ENGAGEMENT_CDP_GROUP_ID` **without** `--drain` left the process consuming `engagement.cdp` while watching
  `dlq.engagement.cdp.int4` — an all-clear about a queue nobody was filling, which is the exact failure the
  0.6.0 rule warns about. Two readers of one value with different defaults.
- **The fix is structural, not a guard: `buildConsumers` is now the only place a consumer is constructed**,
  called by both modes, and the only differences they may pass are the two that are genuinely about the mode
  (`fromBeginning`, and the drain's per-batch hook). A future consumer cannot drift because there is nowhere
  else to add one. Chosen over "refuse the overrides unless `--drain`" because the override is about WHICH
  group, never about which code path read it — and window 12's new ingest (#600) copies this pattern.
- **`resolveConfig` refuses the one remaining way to split them**: an explicit `ENGAGEMENT_DLQ_GROUPS` that
  omits a group this process runs. More groups than we run stays fine (production must list every group on
  the bus, other windows' included); fewer is refused with a message naming the group.
- **Every configuration refusal now exits 2** (`ConfigRefusedError`, which `ConsentModeConfigError`
  extends): a supervisor that restarts on a crash must not restart on an environment that has already been
  refused — the same environment is refused again, forever, and the restart loop buries the message. 1 stays
  "something went wrong at runtime". **All 16 refusals in `config.ts` are that class** (#613 review: the
  claim was wider than the code), and a test pins every one of them, because the entry point decides the
  exit code and the printing from the CLASS. The message is printed for this class only, and that holds
  only while these messages name variables and echo values this repository chose — a mode, an adapter, a
  group id, a port — and never the value of a credential-bearing variable.
- **The `started` / `stopped` log lines print the RESOLVED group id**, not the module constant (#613 review):
  the same drift as #599 one level down, in all three consumers. A log line that names the default while the
  consumer runs another group cannot answer the one question it exists for.
- The drain report says `ran`, not `enabled`: ops has no switch, so `enabled.ops: true` was a constant
  dressed up as a resolved value (#599 nit).
- Tests: **445 passing / 9 live skipped offline** (21 files) after the #613 review fixes; 441/441 with the
  broker up before them (21 files, 112 s; live blocks self-cleaning: cdp 30 topics, crm 21, ops 12). `src/main.test.ts` is new and states the invariant — every group a consumer
  runs is a group the watch watches — across six configurations including the one that was broken, with no
  broker and no database, because constructing a consumer connects to nothing.

## 0.6.0 — 2026-10-25 (#594, Integration 4 step 3)

What this service needed in order to be MEASURED on the real dev stack, and nothing else: the consumers'
behaviour is unchanged.

- **`--drain` (`pnpm drain`), the one-shot measurement mode.** It starts every enabled consumer, reads from
  the beginning, waits until the bus has gone quiet, stops and prints one report. It is a mode rather than a
  script because the measurement has to be the real wiring — the same consumers, handlers and marks — and
  deliberately NOT `--once`, which is the DLQ poll and stays what it was (`pnpm once` and the runbooks mean
  it).
- **A fresh consumer group per module**, `ENGAGEMENT_{OPS,CDP,CRM}_GROUP_ID`, validated against the same
  CHECK `consumer_processed.group_id` has, so a group the table would refuse fails the boot instead of the
  first mark (window 15's `ACCOUNTING_GROUP_ID` pattern, #594). `fromBeginning` is what makes a fresh group
  see history rather than wait for the next message. **The DLQ watch now defaults to the groups the process
  actually runs:** watching `engagement.cdp` while running `engagement.cdp.int4` reads as "all clear" about a
  queue nobody is filling.
- **Stopping is a rule, not a timeout** (`src/drain.ts`): a fresh group must join and be assigned partitions
  before anything can arrive, so "nothing yet" and "nothing left" are indistinguishable at first. A run lasts
  at least `ENGAGEMENT_DRAIN_MIN_RUN_MS` and ends `ENGAGEMENT_DRAIN_IDLE_MS` after the last batch, reporting
  `idle`, `empty` or `max_run` — a run that cannot stop is a result, not something to swallow.
- **The report is built from the log lines the consumers already emit**, with each consumer's own counters
  printed beside it: two paths to one answer, and a disagreement means the report is wrong. That caught its
  own bug on the first real run — a dropped CDP line still carries the `call` the mapper produced, so the
  call counts read 149 tracks against 148 sends. Calls are now counted only for what was SENT, with a test.
- **`ENGAGEMENT_CRM_MOCK_TOKEN` — a dev stand-in for the `crm-sync` principal (#565); never in production.**
  On the dev stack there is no service principal, so a CRM PII read cannot succeed and the largest piece of
  this service (consent → PII fetch → rollup → upsert) could not be measured at all. With the core on
  `CORE_DEV_TOKENS=1` a `dev:<subject>` token lets that path run on real data. It is a STAFF subject, so it
  is labelled as a stand-in everywhere it appears; `resolveConfig` refuses the value in production whether or
  not the CRM is enabled, and a test pins that refusal alongside the mock provider's own. Manager-approved
  (#594) as a dev-only exception to "CRM uses this service's own principal, never a human's token", which
  otherwise stands.
- `StoreCodes.codes()` is shared: the entry point warms one cache for its own checks and hands the same
  instance to the CDP consumer, so the organization's stores are read once per process.
- Tests: **423 passing, 9 live skipped** with the broker offline (was 405/9) — config 74, drain 7, plus the
  rest.

### What the run showed (the numbers are in the Integration 4 report)

- **CDP: 152 events, 148 sent, 4 dropped, 0 dead letters.** 144 `order.placed` → _Order Completed_, 3
  `identify`, 1 `shipment.shipped` → _Order Shipped_. All four drops are `no_identity` in `analytics` mode —
  two `order.cancelled` and two `shipment.shipped` — which is **#584's guest-lifecycle asymmetry on real
  data**: those topics carry neither a `customer_id` nor an `email_hash`, so a guest's later lifecycle is
  invisible while their _Order Completed_ is not. 126 of the 144 orders are guests, tracked under their hash.
- **CRM: 149 events, 20 upserted, 129 skipped, 0 dead letters.** The 20 are the one consented brand-A
  customer's events; the skips are 128 `no_identity` (guest orders) and 1 `consent_absent`.
- **OPS: 0 events** — the dev stack has never produced a `payment.failed`, `refund.failed` or
  `return.requested`, so the rules are exercised by the suite and not by this data. Recorded as a coverage
  gap, not a pass.
- **PII sweep: 0 hits** on the 152 CDP calls, the dev sink and all 312 log lines of the run.
- **The live support-context call (#569's Integration 4 item) answers from the real core:** 200 with that
  customer's 18 orders through `listOrders?customer_id=`, and a brand-B customer under the brand-A store is 404. The fake-reader caveat recorded on #556 is closed.

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
- Tests: **405 passing, 9 live skipped** with the broker offline (was 385/9) — config 63, CDP consumer 33
  (30 + 3 live), support server 30, the new boot tests, plus the rest.

### The #590 review fix: "fails the boot" was not true

The check was in the right place for a consumer and the wrong place for a boot. `createCdpConsumer.start()`
threw as designed, but `main()` had already started the OPS consumer, so the throw reached a handler that
logged `error_class: "Error"` and set `process.exitCode = 1` — and nothing exited. A running consumer keeps
the event loop alive, the SIGTERM handlers below were never registered, and the service stayed up consuming
with a configuration it had just refused, while the message naming the offending variable was discarded.

- **The check now runs before anything starts.** `main()` creates ONE `StoreCodes`, warms it, and validates
  the override keys before the first `start()` — and hands that same warmed instance to the CDP consumer, so
  the organization's stores are still read once per process (`warm()` is now idempotent, and
  `createCdpConsumer` takes an optional `storeCodes`). The consumer keeps its own check, for a consumer
  constructed anywhere else.
- **`ConsentModeConfigError`** is the class for every consent-mode configuration failure: a bad value, two
  disagreeing spellings, a bare prefix, an unknown store. The crash line prints its MESSAGE as well as its
  name — the one exception to "the class only, never the message", and a narrow one: these messages are built
  in `consent-mode.ts` out of env variable names and store codes, with no payload, secret or personal data in
  them. A test pins that every one of those failures is this class, because that is what makes printing safe.
- **The crash line is written synchronously and the process exits 1.** `process.exitCode` alone does nothing
  while something is still running, and `process.exit` can truncate a buffered write to a pipe — the whole
  point of the line is that it reaches whoever reads the logs.
- **Startup is all-or-nothing:** a failure part-way through stops what already started, newest first, closes
  the server, ends the pool, and rethrows. A failure to stop never masks the failure to start.
- **A bare `ENGAGEMENT_CDP_CONSENT_MODE_` with nothing after it now fails** instead of being skipped. Whoever
  set it believes they configured a store.
- **`src/main.boot.test.ts` boots the real entry point as a child process**, because nothing in-process can
  assert an exit code: a bad override exits 1, the crash line names `ConsentModeConfigError` and the variable,
  and no `started` line is ever printed. Against the old code the first of those tests would hang until its
  timeout — which is exactly the defect.
- The "before the broker" test no longer depends on the broker being down: it passes a kafka seam that throws
  if touched, and a second test proves a VALID override does reach it. The order is asserted, not inferred.

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
