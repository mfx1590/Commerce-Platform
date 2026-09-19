# Memory 8 — Shipping & fulfillment
Window: 8 · Key: `shipping` · Branch prefix: `shipping/` · Model: Sonnet
Last updated: 2026-09-08 · Contracts: contracts-v0.3 (Store API 0.3.0, Admin API 0.3.0, events 0.2.0, db 0.2.0; tagged at the end of Integration 1) · Branch: `shipping/phase2` · Status: 2.1 merged-in-review (#175), 2.2 done (commit ddec7b3, PR pending push), 2.3 next

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
- **2.5 (#133) — pick/pack lifecycle, events, admin operations** · local commits (see git log) · PR after 0.4.3
  `fulfillment/lifecycle.ts` (`pickShipment` / `packShipment` / `listPickLists`), `lifecycle-events.ts` (the
  seam that writes to the outbox the moment events 0.3.0 exists and buffers with one warning until then),
  `fulfillment/http.ts` (three Admin API operations, permissions read from the real spec or #225's filed copy),
  the widened status machine in `shipping/shipments.ts`, and all six review nits. Full core suite: 537 passed,
  5 skipped, 0 failed.
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
- **2.5 (#133) is code-complete locally**, three commits on `shipping/phase2` after the 2.4 ones. Waiting on the
  manager's landing order: #227 → #229 → contracts-v0.4.3 (#225 + #228) → confirmation → then push 2.5 as its
  own PR. **Do not push before that confirmation.**
- When 0.4.3 is on main, in the PR that merges it: delete `fulfillment/proposed/0160_shipment_pick_pack.sql`,
  `fulfillment/proposed/admin-api.pick-pack.yaml`, the test-side DDL in `lifecycle-db.test.ts` and
  `shipments-db.test.ts`, and the `permissionFor` fallback in `fulfillment/http.ts`. The lifecycle events start
  reaching the outbox on their own — `lifecycleEmitter` checks `EVENT_TOPICS` at call time — so the only change
  needed there is deleting the buffer assertions in the "not in the outbox yet" test.

## Fold into 2.5 (#133) — DONE, all six
- `buyShipmentLabel`'s carrier call is outside the transaction, with the bought label voided if the shipment moved.
- `verifyEasyPostSignature` accepts only `hmac-sha256-hex` or a bare digest.
- A tracking number matching two shipments is ambiguous: recorded, skipped, neither shipment moves.
- A cross-organization shipment id is a 404 from the router (tested against a second organization).
- `cancelFulfillment` records a divergence instead of swallowing it when the provider cancels what we cannot.
- `applyFulfillmentUpdate` moves the shipment before recording the provider state, so a retry still works.

## Next — Phase 2 (GitHub issues; acceptance criteria there are authoritative)
- [x] **#129 · 2.1** Carrier provider interface + EasyPost (test mode) — done, PR #175 in review
- [x] **#130 · 2.2** Rate shopping at checkout — done, PR #186 in review
- [x] **#131 · 2.3** Labels and tracking webhooks — done, PR pending
- [x] **#132 · 2.4** 3PL adapter interface + in-memory implementation — PR #223 in review
- [x] **#133 · 2.5** Pick/pack state machine and events — code-complete locally, PR after 0.4.3

## Decisions made (with reasons)
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
- `webhook_event` lands as migration 0140 (#187) after both shipping 2.3 and payments 2.2 merge; until then only
  the tests create the proposed DDL. Delete `PROPOSED_WEBHOOK_EVENT_SQL` when 0140 is on main.

## Gotchas learned
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
- `pnpm turbo run build --filter=@platform/auth-sdk --filter=@platform/db --filter=@platform/events --filter=@platform/contracts`
  once after a fresh worktree or a `git merge main`.
- `pnpm --filter @platform/core exec vitest run src/modules/shipping` — this module only (fast, no database).
- Gates before finishing a task: `pnpm lint && pnpm typecheck && pnpm test --filter @platform/core`.
- Live EasyPost suite: put a test-mode key (`EZTK…`) in the repo-root `.env` as `EASYPOST_API_KEY`; without it
  the suite skips.
