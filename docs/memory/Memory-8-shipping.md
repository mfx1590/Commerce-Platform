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
- **2.3 (#131) — labels, shipments and tracking webhooks** · commits `6f69b97` + `SHA_PORTS` · PR pending
  `shipments.ts` (plan a shipment against what the order still owes, buy its label, the status machine and its
  outbox events), `tracking.ts` (verify HMAC over the raw body, record the event id, then apply — forward only,
  on the carrier's clock), `webhook-events.ts` (shared idempotency record + the proposed table SQL),
  `ports.ts`. 21 unit tests + 15 database tests. Admin API routes already exist in the contract — no CONTRACT
  CHANGE needed. **Follow-up commit `SHA_PORTS`:** the orders mirror is replaced by the real core 2.3 functions
  (`markShipmentCreated` / `markShipped` / `markDelivered`), so planning a shipment advances the order to
  `processing` and fulfilment is recorded on despatch, not on plan. Inventory stays a mirror — core 2.4 has NOT
  merged (no `modules/inventory` on main), contrary to the merge note.
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
- (nothing — 2.4 is next: `apps/core/src/modules/fulfillment`, FulfillmentProvider + per-warehouse routing)

## Next — Phase 2 (GitHub issues; acceptance criteria there are authoritative)
- [x] **#129 · 2.1** Carrier provider interface + EasyPost (test mode) — done, PR #175 in review
- [x] **#130 · 2.2** Rate shopping at checkout — done, PR #186 in review
- [x] **#131 · 2.3** Labels and tracking webhooks — done, PR pending
- [ ] **#132 · 2.4** 3PL adapter interface + in-memory implementation
- [ ] **#133 · 2.5** Pick/pack state machine and events

## Decisions made (with reasons)
- **Orders functions run inside shipping's transaction via `clientOn(tx, client)`** (2.3 follow-up): they take a
  `ScopedClient` and open their own transaction, and handing them the outer client deadlocks — our shipment
  insert holds a key-share lock on the order row that their `SELECT … FOR UPDATE` waits for, on a connection we
  are waiting for. The adapter makes `transaction(fn)` run `fn(tx)`, so everything commits together.
- **Calls to the orders module are advisory** (2.3 follow-up): a 409 from its state machine (shipment planned
  before anyone confirmed the order; delivery before every line shipped) is reported in the outcome, not thrown.
  A carrier webhook must not fail for ever because an operator has not confirmed an order.
- **Fulfilment is recorded on despatch, not on plan** (2.3 follow-up): `markShipped` takes the quantities that
  actually left. Planning only moves the order to `processing`.
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
- REQUEST filed for the main window: add the shipping variables to the root `.env.example`
  (`EASYPOST_API_KEY`, per-store `EASYPOST_API_KEY_<CODE>`) — issue #173. Root config is main-window-only; the module reads
  the environment and runs on `manual` when nothing is set, so nothing is blocked meanwhile.
- 2.3 needs the shared `webhook_event` table. **No CONTRACT CHANGE issue exists yet**; window 7 owns filing it
  (their 2.2, #125, lands first). Shipping's requirements are posted as a comment on #125 on 2026-09-08: UNIQUE
  (provider, external_id) rather than a global unique id, a nullable `occurred_at` for the carrier's own clock
  (delivered-before-shipped ordering), and a note that an EasyPost payload contains an address. Offered to file
  it myself if window 7 has not started. Check #125 before starting 2.3.

## Gotchas learned
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
