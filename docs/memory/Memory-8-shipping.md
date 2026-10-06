# Memory 8 — Shipping & fulfillment
Window: 8 · Key: `shipping` · Branch prefix: `shipping/` · Model: Sonnet
Last updated: 2026-10-06 · Contracts: contracts-v0.4.11 (Admin API 0.4.9 adds `buyShipmentLabel` + the shared `Unprocessable` 422; events 0.3.1 adds `shipment.label_created`; db 0.3.0) · Branch: `shipping/phase3` (off `origin/main`; `shipping/phase2` is dead — only its memory commit was carried over) · **Status: INTEGRATION 2a — #356 done locally, PR open.**

## Identity (does not change)
Owned paths (write):
- `apps/core/src/modules/fulfillment/**`
- `apps/core/src/modules/shipping/**`
Reads:
- packages/contracts
- packages/events
Never touches:
- other core modules

## Mission — Phase 2 (Commerce complete, brand 1 live)
EasyPost/ShipEngine provider (rates, labels, tracking webhooks), 3PL adapter interface with in-memory impl, pick/pack state machine, shipment events on the outbox. Wave B — starts when core 2.1–2.2 have merged.

## Done
- **#356 · Integration 2a — buy-label route, `shipment.label_created`, lifecycle to `delivered`** · branch
  `shipping/phase3` · PR #369, code commit `4dd85e7` (this memory commit sits on top of it; the merge sha
  goes here when it lands) · body says `Refs #356`, not `Closes`: the issue closes at the Integration 2a
  gate, when a real test-mode label prints
  `POST /admin/shipments/{shipmentId}/label` on `shippingAdminRouter` (permission from the spec: `operations` on
  `organization:hq`, no request body, store resolved from the shipment). `buyShipmentLabel` now matches Admin API
  0.4.9 instead of its old README: **409 unless the shipment is exactly `packed`** (an already-labelled shipment is
  `label_created`, so a second call is a 409 and not the label it holds), **422 `provider_unsupported`** when the
  store's carrier declares `canBuyLabels: false` (the manual carrier), and still **502** for a carrier that is
  merely down. `shipment.label_created` (events 0.3.1) goes on the outbox in the same transaction as the move,
  sharing one timestamp with `metadata.carrier_label.bought_at`. New `createTestCarrierProvider()` is the manual
  implementation under another name — the carrier test double every label test now buys from. Module suites
  187 passed, 2 skipped (the EasyPost live tests — no key in this worktree yet).
- **#255 — outbox-order flake in the module's database tests** · commit `aaabf73` · PR #343, merged as `bc3a346` (2026-10-05); #255 closed
  `shipments-db.test.ts` ordered a shipment's outbox rows by `occurred_at, topic`; the skipped-scan test expected
  `delivered` before `shipped`, true only on an occurred_at tie (alphabetical). Every shipment/order stream query in
  shipping and fulfillment tests now orders by `seq` (outbox identity = write order), and the skipped-scan test
  asserts the product's guarantee: `shipped` then `delivered`. Test-only change; 20/20 runs of the file green;
  full core suite 815 passed, 6 skipped, 0 failed.
- **2.5 (#133) — pick/pack lifecycle, events, admin operations** · PR #235 (contracts-v0.4.3)
  `fulfillment/lifecycle.ts` (`pickShipment` / `packShipment` / `listPickLists`), `lifecycle-events.ts` (the
  three `fulfillment.*` events, written to the outbox in the same transaction as the move; the `EVENT_TOPICS`
  check stays as a guard), `fulfillment/http.ts` (three Admin API operations, permissions from `admin-api.yaml`
  0.4.3 through `loadSpec`),
  the widened status machine in `shipping/shipments.ts`, and all six earlier review nits. **#235 BLOCK fixes**
  (commit `133b03e`): `fulfillment.requested` is emitted from `requestFulfillment` with `provider` and
  `external_id`, in the same transaction as the reference; a 3PL-driven `picking` / `packed` goes through the
  same `pickShipment` / `packShipment` call as the Admin API, so the stream never shows who moved the shipment;
  and cancelling a shipment that holds a label voids it first, recording `needs_reconciliation` and raising when
  the void itself fails. Full core suite: 591 passed, 6 skipped, 0 failed.
- **2.4 (#132) — 3PL adapter + per-warehouse routing** · commit `23f3498` · PR #223
  New module `apps/core/src/modules/fulfillment`: `routeFulfillment` (pure; store country override → store default
  → same country → same region → priority), `FulfillmentProvider` (`push` / `status` / `cancel`) with the in-memory
  3PL (cancel refused once picking), `requestFulfillment` / `cancelFulfillment` / `applyFulfillmentUpdate` with no
  transaction across a provider call and a compensating cancel on a failed push. Shipping gained
  `readShipmentMetadata` / `writeShipmentMetadata`. README documents the real-3PL mapping. 16 unit + 9 database tests.
- **2.3 (#131) — labels, shipments and tracking webhooks** · commits `6f69b97` + `f305919` · PR pending
  `shipments.ts` (plan a shipment against what the order still owes, buy its label, the status machine and its
  outbox events), `tracking.ts` (verify HMAC over the raw body, record the event id, then apply — forward only,
  on the carrier's clock), `webhook-events.ts` (shared idempotency record + the proposed table SQL),
  `ports.ts`. 21 unit tests + 15 database tests. Admin API routes already exist in the contract — no CONTRACT
  CHANGE needed. **Ports now call the real modules** (commit `e9fc154`): orders `…InTx` markers and inventory
  `consumeReservationsForShipment` / `releaseReservationsForShipment`, all on shipping's transaction. Planning
  advances the order to `processing`; fulfilment is recorded on despatch, not on plan. My earlier "core 2.4 not
  merged" finding was a stale tree — it was on main.
- **2.2 (#130) — rate shopping at checkout** · commit `7de8158` · PR #186
  `rate-shopping.ts`: the cart module's `ShippingRateProvider`. `shipping_option` rows decide which options
  exist and who is eligible (ids stay real rows so checkout can freeze them); a row with `rules.live` + `service`
  is priced by the carrier. Fallback to flat table prices on any carrier failure. 60 s quote cache keyed on a
  sha256 of the destination. `registerCarrierProviders()` is the boot mount point (REQUEST #176, commented on
  window 7's issue as the manager asked — one issue, two lines). Folded in: `BoundedTtlMap` bounds every
  in-process index; EasyPost retries safe calls with backoff and never retries buy/void. 22 unit tests +
  6 database tests (248 core tests green).
- **2.1 (#129) — carrier provider interface + manual and EasyPost providers** · commit `32788f7` · PR #175
  `apps/core/src/modules/shipping`: `CarrierProvider` (rates / buyLabel / voidLabel / track / validateAddress),
  in-memory deterministic `manual` provider, EasyPost provider over global fetch (test mode only), provider
  registry, per-store credentials + settings, address redaction, minor-unit conversion. 48 unit tests + a live
  EasyPost suite that skips without `EASYPOST_API_KEY`. README + CHANGELOG in the module folder.

## In progress
- **#356 / PR #369 — reviewed MERGE (Fable static review, 2026-10-06); skipped by the queue once on a
  conflict with #370, re-merged against main `e708727` (which carries #368 and #370's `5e10724`) and
  re-gated, so it queues again on green.** Nothing else is being
  written on this branch. When it merges, put the merge sha on the Done entry and clear this.
- **Owed after contracts 0.4.12 lands** (the manager lands `ERROR_CODES` + the core's status map once #368/#369
  are in): delete the `PROVIDER_UNSUPPORTED` cast in `shipping/shipments.ts` and use the real `ErrorCode`. One
  line, plus the comment above it.
- **#366 part 2 waits for #350 to be on main**: call `markShipmentStartedInTx` when a shipment leaves `pending`.
  The function does not exist on main yet. Part 1 (tests only) is PR #370 on `shipping/366-tests`, the manager's
  one-time second branch.
- Not mine, tracked elsewhere: window 1 mounts `fulfillmentAdminRouter()` with one `routers.push(...)` line in
  `src/http/module-routers.ts`. `shippingAdminRouter` and `shippingWebhookRouter` are already mounted there, and
  `registerCarrierProviders()` runs from `src/wiring.ts`.

## Follow-ups for whoever reopens this window (none blocking, agreed with the manager)

Two are real behaviour, three are hygiene. In the order I would do them:

1. **`voidLabelForCancel` resolves the store's CURRENT carrier, not the one that sold the label.**
   `shipping/shipments.ts` reads `store.settings.shipping.provider` to find a provider, but the label records its
   own `metadata.carrier_label.provider`. A store that switches carrier after buying a label would void against
   the wrong one. Fix: resolve by `ref.provider` (falling back to the store's when it is not registered), and add
   a test that switches the store's provider between buy and cancel.
2. **A successful void is not recorded.** Only failures write to `metadata.carrier_label`. If the cancel
   transaction fails right after a successful void, a retry voids an already-voided label — harmless with
   EasyPost today, not guaranteed elsewhere. Fix: write `voided_at` in the cancel transaction and skip the call
   when it is set.
3. ~~**Stale comment in `shipping/shipments.ts`** about `../fulfillment/proposed/0160_shipment_pick_pack.sql`.~~
   Fixed in #356 (same file, one comment).
4. **`fulfillment/README.md` contradicts itself**: the "why they are not in the outbox yet" framing survives in
   one paragraph although the events have flowed since contracts-v0.4.3.
5. **Document the emitter buffer as a guard, not a queue** (`fulfillment/lifecycle-events.ts`): it warns once per
   process and holds at most 200 entries for an hour. It exists so an unknown topic cannot fail a correct
   warehouse operation — it is not a retry mechanism and nothing drains it.

## Fold into 2.5 (#133) — DONE, all six
- `buyShipmentLabel`'s carrier call is outside the transaction, with the bought label voided if the shipment moved.
- `verifyEasyPostSignature` accepts only `hmac-sha256-hex` or a bare digest.
- A tracking number matching two shipments is ambiguous: recorded, skipped, neither shipment moves.
- A cross-organization shipment id is a 404 from the router (tested against a second organization).
- `cancelFulfillment` records a divergence instead of swallowing it when the provider cancels what we cannot.
- `applyFulfillmentUpdate` moves the shipment before recording the provider state, so a retry still works.

## Next — Integration 2a
- [x] **#356** buy-label route + `shipment.label_created` + the tracking lifecycle to `delivered` — PR open.
- [ ] **#366** (REQUEST, addressed to this window, NOT in #356's scope): report the first shipment leaving
      `planned` to the orders module (`markShipmentStarted`) and update two tests to the automatic lifecycle
      (#350). Raised with the manager; waiting for it to be scheduled.
- [ ] The real EasyPost round trip through the route needs `EASYPOST_API_KEY*` in this worktree's `.env`
      (OWNER issue #361) and the MACHINE, which belongs to window 5. Until then the route is covered against the
      carrier test double and `easypost-live.test.ts` skips loudly.

## Next — Phase 2 (all delivered)
- [x] **#129 · 2.1** Carrier provider interface + EasyPost (test mode) — PR #175
- [x] **#130 · 2.2** Rate shopping at checkout — PR #186
- [x] **#131 · 2.3** Labels and tracking webhooks — PR #218 (merge `968c93f`)
- [x] **#132 · 2.4** 3PL adapter interface + in-memory implementation — PR #223
- [x] **#133 · 2.5** Pick/pack state machine and events — PR #235 (merge `7e02172`)

Contract changes this window filed: **#187** `webhook_event` (with window 7, landed as migration 0140) and
**#225** pick/pack (landed as migration 0160 + events 0.3.0 + Admin API 0.4.3). Requests: **#176** (boot + mount
lines), **#191** (order and inventory port shapes), **#226** (`apps/core/CLAUDE.md` rows).

## Decisions made (with reasons)
- **An already-labelled shipment is a 409, not the label it holds** (#356): the old call was idempotent and
  answered 200 with the existing label. Buying a label is real money, and an operator who repeats the call must
  learn that the state changed under them. It also falls out of the contract's own rule — only `packed` is
  labellable, and a labelled shipment is `label_created`. **This contradicts #356's own "idempotent" bullet**,
  which predates Admin API 0.4.9; the contract and the manager's instruction win, and the PR body says so.
- **A carrier outage stays a 502, it is not 422** (#356): 422 `provider_unsupported` says the carrier can *never*
  do this (a permanent capability), so a client must not retry. An outage is the opposite — retrying is exactly
  right. No operation in the spec documents any 5xx, so 502 is undocumented either way; mapping an outage to a
  documented-but-wrong code would be worse than an undocumented-but-true one.
- **Label capability is a property of the provider object, not a name check** (#356): `CarrierProvider.canBuyLabels`,
  absent = capable, so only a carrier that genuinely cannot buy labels has to say so and no caller has to keep a
  list of carrier names. `manual` declares `false`; `createTestCarrierProvider()` is the same implementation under
  another name and refuses to be registered as `manual`, so the double can never impersonate the carrier whose
  422 it exists to work around.
- **The provider and the carrier are different names** (#356): the test double's provider name is `test-carrier`
  while its labels still say `carrier: manual` (it keeps the manual pricing table). `shipment.carrier` and the
  event carry the *carrier* that moves the parcel, not the integration that bought the label. The db tests assert
  both separately.
- **`provider_unsupported` is mocked in this module, not in the contract** (#356): admin-api.yaml 0.4.9 documents
  it on `Error.code` but `ERROR_CODES` in `@platform/contracts` does not list it, and that package is the main
  window's. `PROVIDER_UNSUPPORTED` in `shipments.ts` is one cast with the deletion condition written next to it.
- **A failed label void refuses the cancel** (#235 fix): the carrier still holds a live label nobody will use, so
  the failure is written to `shipment.metadata.carrier_label` (`needs_reconciliation`) and raised, and the
  shipment stays put. Cancelling anyway would hide a paid label from everyone. Same rule as `cancelFulfillment`.
- **The provider's shipment id lives on `metadata.carrier_label`** (#235 fix): a void needs it and no contract
  column holds it. `buyShipmentLabel` writes it in the same statement that records the label.
- **One lifecycle call per move, whoever asked** (#235 fix): `applyFulfillmentUpdate` routes `picking` / `packed`
  through `pickShipment` / `packShipment` rather than `updateShipment`, so a 3PL and an operator produce the same
  events. A consumer must not be able to tell them apart.
- **The lifecycle's legality check lives in the caller** (2.5): `applyTransition` writes what it is told, so
  `move()` in `fulfillment/lifecycle.ts` calls `canTransition` first. The first version did not, and the tests
  caught a backwards move writing `picking` over `shipped`.
- **An operator's illegal move is a 409, a carrier's is a skip** (2.5): a person pressing the wrong button should
  hear about it; a carrier delivering scans out of order should not create noise.
- **Permissions are read from a spec even when the spec is still proposed** (2.5): `permissionFor` prefers the real
  `admin-api.yaml` and falls back to `proposed/admin-api.pick-pack.yaml`, so no permission is ever hard-coded and
  the fallback deletion is a one-line change.
- **No database transaction across a provider call** (2.4): a 3PL can take seconds or time out, and a held
  transaction pins a connection and the order row's locks. Flows are short transactions around the network call
  with explicit compensation — a failed push cancels the shipment, which releases its stock.
- **Routing is a pure function with the rule that won in the result** (2.4); store settings name warehouses by
  `code`, and an unknown code is ignored rather than failing the order.
- **The 3PL reference lives on `shipment.metadata.fulfillment`** (2.4); the provider echoes our shipment id.
- **The default provider is named `memory`** (2.4): it forgets jobs on restart, so it must not sound production-ready.
- **A shared-table CONTRACT CHANGE is copied, never re-typed** (#218 review, 2026-09-15): `proposed/0140_webhook_event.sql`
  is a byte copy of #187's fence (identical to payments'), and a test compares the two files while both exist. My
  first draft re-typed the shape from my own proposal on #125 and diverged from what was accepted.
- **No raw provider body on any row** (#187): shipping stores a redacted extract (event id, type, tracker id,
  tracking code, carrier, status, carrier timestamp) plus `payload_hash` = sha256 of the raw body. Scan locations
  count as address data and are dropped.
- **A module that has routes ships its routers** (#218 review): `shippingWebhookRouter` / `shippingAdminRouter` in
  `http.ts`, following payments' `webhook-router.ts` and search's `http.ts`; permissions from the spec via
  `permission(operationId)`. A README sentence saying window 1 mounts it is not a deliverable.
- **Orders calls are advisory, inside a SAVEPOINT** (2.3): a 409 from the order's state machine (shipment planned
  before anyone confirmed the order; delivery before every line shipped) is reported, not thrown, and rolls back
  to the savepoint so a call that wrote rows before refusing leaves nothing behind. Inventory calls are not
  advisory — a stock failure rolls the shipment back.
- **Fulfilment is recorded on despatch, not on plan** (2.3): `markShippedInTx` takes the quantities that actually
  left. Planning only moves the order to `processing`. Stated in the 2.3 PR body as a behaviour change.
- **Verify, record, then apply** (2.3): the webhook checks its HMAC against the raw body before parsing, writes
  the provider event id, and only then moves a shipment — all in one transaction. A carrier retry conflicts on
  the unique row and changes nothing.
- **A carrier scan never errors, it is ignored** (2.3): an illegal transition on the admin route is a 409, but
  the same one from a carrier is a no-op. Carriers deliver scans out of order; a late `in_transit` after
  `delivered` is normal and must not move the shipment back.
- **A shipment that jumps to `delivered` still emits `shipment.shipped` first** (2.3): accounting derives
  shipping cost and COGS timing from that event and would otherwise never see the parcel leave.
- **Ports instead of guesses for core 2.3 / 2.4** (2.3): `OrdersPort` and `InventoryPort` with interim
  implementations — the orders port writes `order.fulfillment_status` directly (the admin and storefront must be
  truthful about a part-shipped order), the inventory port does nothing (a wrong decrement is worse than a late
  one). REQUEST #191 names both shapes; swapping them in is one call at boot.
- **Timestamps are rendered, not passed through** (2.3): node-postgres returns `timestamptz` as a Date, and both
  the Admin API schema and the event schemas want an ISO string. `iso()` is applied at every boundary.
- **The option table owns identity, the carrier owns price** (2.2): a live rate is always attached to a real
  `shipping_option` row. Checkout builds `order.shipping_method` from that row, so a rate invented by this module
  could never be placed. This is the constraint the whole design hangs on.
- **`rules.live` opts a row into carrier pricing** (2.2), with `free_over_subtotal_minor` alongside the domain's
  `min_subtotal_minor` / `max_weight_g`. `rules` is free-form jsonb, so no CONTRACT CHANGE was needed.
- **A carrier failure is never an error to the customer** (2.2): every failure path (down, timeout, retries
  exhausted, no credential, no warehouse, no address, wrong currency) falls back to flat table prices.
- **The registry wins over per-store credentials** (2.2): `setCarrierProvider('easypost', …)` overrides building
  one from a store's key. `easypost` cannot be a single registry entry because keys are per store (ADR 0006).
- **Never retry buying or voiding a label** (2.2, manager's ask): a 5xx can arrive after the label was created;
  a retry would buy a second parcel. Only rates, track and address validation retry (3 attempts, doubling from
  200 ms).
- **Cache keys hash the destination** (2.2): sha256 of the address, so no address sits in a process index in
  readable form even though the cache must distinguish two houses.
- **No SDK for EasyPost** (2.1): one HTTP shape over the global `fetch`. No transitive dependency to audit, the
  request/response mapping stays readable and testable against a fake fetch, and a root `package.json` change
  would have needed the main window.
- **Live EasyPost keys are refused in code** (2.1): `createEasyPostProvider` throws on a key that does not start
  with `EZTK` unless `allowLiveKey` is passed. Phase 2 buys test labels only, and a live key that lands in a
  developer's `.env` must not be able to buy a real one.
- **No FX in the core** (2.1): a carrier rate quoted in another currency than the cart's is dropped, never
  converted. Converting would put an exchange rate in the checkout total that nothing reconciles.
- **Money conversion on the decimal string** (2.1): `toMinorUnits('10.40','EUR')` parses digits, never a float,
  and rounds half away from zero at the currency's exponent (JPY 0, TND 3).
- **`redactAddress` = country + region + two-character postal prefix** (2.1): the only address shape allowed in a
  log, an event or a support note. Dropped, not masked, so no later change can widen it accidentally.
- **Deterministic ids in the manual provider** (2.1): sha1 of the inputs instead of a random source, so tests
  assert exact rate ids, shipment ids and tracking numbers, and a repeated label purchase is idempotent.
- **Per-store carrier settings live in `store.settings.shipping`** (2.1): a jsonb column that already exists and
  that the registry module owns, so no CONTRACT CHANGE is needed for carrier accounts, services or parcel
  defaults. Every field falls back to a default rather than throwing.

## Blocked / waiting
- **#366 part 1 (tests) is in review on `shipping/366-tests`** — a one-time second branch the manager allowed
  while #356 sits on `shipping/phase3`. Test-only: the two `shipments-db.test.ts` cases that asserted
  `order.status` now assert what shipping owns (the order's `fulfillment_status`, and the shipment planned), so
  they hold both on today's main and after #350 changes the order lifecycle. **Part 2 of #366 — calling
  `markShipmentStartedInTx` when a shipment leaves `pending` — waits for #350 to be on main**, because the
  function does not exist there yet; it goes into #356's branch afterwards.
- **One-line follow-up owed after contracts 0.4.12 lands**: drop the `PROVIDER_UNSUPPORTED` cast in
  `shipping/shipments.ts` once `ERROR_CODES` carries `provider_unsupported` (the manager lands it after #368/#369
  merge).

## Gotchas learned
- **Two branches editing one test file collide in the merge queue, and the queue never resolves a conflict**
  (2026-10-06): #370 (tests) and #369 (the label work) both inserted a helper above `orderState` in
  `shipments-db.test.ts`, so #370 merged and #369 was SKIPPED. Resolution was to keep both helpers (`pack` and
  `orderFulfillment`) — trivial, but it costs a merge, a full gate run and a queue slot. When a second branch is
  unavoidable, keep each one's edits in different regions of a shared file, as I managed to for the memory file
  (#370 touched only Blocked/waiting) and failed to for the test file.
- `jsonb_set(settings, ARRAY['shipping','provider'], …, true)` **silently changes nothing** when `settings` has no
  `shipping` key: create_missing creates only the LAST key of the path, and a missing intermediate makes the whole
  call return the document unchanged. Build the object instead:
  `settings || jsonb_build_object('shipping', coalesce(settings->'shipping','{}'::jsonb) || …)`. Cost one test
  failure that looked like the capability check misfiring (#356).
- A shipment event's timestamp is the carrier's string verbatim (`2026-10-07T10:15:00Z`) while the row's column is
  the same instant after Postgres normalised it (`…:00.000Z`). Both are ISO-8601; assert the one the boundary
  actually produces rather than assuming the two spellings match (#356).
- Reporting to the manager (since 2026-10-05 via session messaging): send a message AS SOON AS the PR is up,
  then a second one when every check has finished. On #343 I waited for CI and the manager found the PR in the
  list first. A red check caused outside the diff (e.g. live suites sharing the owner's one-time code, fixed by
  #347) is the manager's call, not a reason to push again.
- Order outbox rows in tests by `seq` alone, never `occurred_at`: occurred_at is a wall clock per event (two events
  of one transition can tie or straddle a millisecond), `seq` is the identity column and the write order (#255).
- After a contract lands, **rebuild the workspace packages** before judging anything: `@platform/events` generates
  `EVENT_TOPICS` from its schemas at build time, so a stale build reports brand-new topics as unknown
  (2026-09-19, after contracts-v0.4.3).
- Declaring an event topic and carrying its payload branch is not emitting it. `fulfillment.requested` existed in
  the seam and in the contract for a whole PR before the review noticed no caller ever wrote it — an outbox-row
  assertion per topic is the only thing that catches this.
- When a fix must go into an open PR while later work sits unpushed on the same branch: park the later commits on a
  local branch, reset to `origin/<branch>`, fix, push, then replay. Pushing first would have put 2.4 into #218.
- Test fixtures that place many orders must rotate variants: since shipments consume real stock, one variant ran
  dry ("Only 1 left") after about ten orders.
- `updateShipment`'s path names no store. Resolve the shipment's store through `organizationClientFor(p)` and then
  use `storeClientFor(p, storeId)`, so RLS and the principal's store scope both still apply.
- A "module does not exist on main" check must run against a freshly fetched and merged tree. On 2026-09-09 this
  window reported core 2.4 as unmerged from a stale checkout; it was already on main.
- `src/modules/hq-rbac/test/scope.test.ts` (window 2's live suite) fails locally with Keycloak `invalid_grant`
  for `owner` (2026-09-15, 3 tests). It is the owner's password+TOTP grant, not OpenFGA tuples, so
  `fga:seed` does not fix it. Not shipping's; CI's auth-e2e job runs it on a fresh stack.
- Postgres `timestamptz` reaches the app as a JS `Date`, not a string. A row typed `string | null` that goes
  straight into a contract response or an event payload will fail schema validation or produce `[]` in a test —
  render it with `iso()` at the boundary.
- Heredocs in the Bash tool break on longer scripts (the shell reports "unexpected EOF"): write the script with
  the Write tool into the scratchpad and run `python <path>`. Same finding as the earlier note in this file.
- `PricingContext` carries no store code, warehouse or line weights: read them through `ctx.tx` inside the same
  transaction (RLS keeps it in the store). `completeCart` needs an `actor` in its input — a missing one fails
  deep inside the outbox helper with "Cannot read properties of undefined".
- Adding a retry changed an existing error test that queued one response per call. A fake-fetch queue and a
  retry loop interact: pin `maxAttempts: 1` in tests that assert the mapping rather than the retry.
- `describe.skipIf(...)` still runs the describe callback: anything at that level (building a provider from an
  API key) executes even when every test is skipped. Build such fixtures inside the tests.
- The core's tests need the workspace packages built first, or Vitest fails to resolve `@platform/db`:
  `pnpm turbo run build --filter=@platform/db --filter=@platform/events --filter=@platform/contracts --filter=@platform/auth-sdk`.
  `rm -rf apps/core/.medusa` before `typecheck` (issue #72).
- Integration 1 (2026-09-08): real Keycloak staff tokens are the default on the core's Admin API; `CORE_DEV_TOKENS=1` keeps `Bearer dev:<subject>` working locally. The storefront can run against the core with `STORE_API_URL=http://localhost:9000` (+ `CORE_STORE_API_FALLBACK=1` + `CORE_STORE_API_FALLBACK_URL=http://localhost:4010` on the core so unimplemented Store routes still answer from Prism). The admin uses `ADMIN_API_URL`.

## How to run & test this package

- Prerequisites once: `pnpm dev` at the repo root (shared docker stack — Postgres 5433, Redis 6381), then
  `pnpm install`. **Never** `pnpm dev --reset` or `docker compose down`: other windows share the stack.
- After merging main, **rebuild the workspace packages before judging anything**:
  `pnpm turbo run build --filter=@platform/events --filter=@platform/db --filter=@platform/contracts --filter=@platform/auth-sdk`.
  `@platform/events` generates `EVENT_TOPICS` from its schemas at build time, so a stale build reports new topics
  as unknown.
- Gates, in this order: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test --filter @platform/core`.
  Remove `apps/core/.medusa` before the root gates.
- Just this window's code: `pnpm --filter @platform/core exec vitest run src/modules/shipping src/modules/fulfillment`
  (181 tests, ~40 s; the database suites create their own throwaway databases).
- `easypost-live.test.ts` skips itself unless `EASYPOST_API_KEY` is set, and refuses a non-test key.
- `src/modules/hq-rbac/test/scope.test.ts` (window 2's live suite) is intermittently red locally on the owner's
  password+TOTP grant. Re-run that file alone before reporting it; CI is authoritative.
