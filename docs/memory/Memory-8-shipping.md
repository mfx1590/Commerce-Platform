# Memory 8 — Shipping & fulfillment
Window: 8 · Key: `shipping` · Branch prefix: `shipping/` · Model: Sonnet
Last updated: 2026-09-08 · Contracts: contracts-v0.3 (Store API 0.3.0, Admin API 0.3.0, events 0.2.0, db 0.2.0; tagged at the end of Integration 1) · Branch: `shipping/phase2` · Status: 2.1 done (PR #175 in review), 2.2 next

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
- **2.1 (#129) — carrier provider interface + manual and EasyPost providers** · commit `32788f7` · PR #175
  `apps/core/src/modules/shipping`: `CarrierProvider` (rates / buyLabel / voidLabel / track / validateAddress),
  in-memory deterministic `manual` provider, EasyPost provider over global fetch (test mode only), provider
  registry, per-store credentials + settings, address redaction, minor-unit conversion. 48 unit tests + a live
  EasyPost suite that skips without `EASYPOST_API_KEY`. README + CHANGELOG in the module folder.

## In progress
- (nothing — 2.2 starts next; the plan is under Next)

## Next — Phase 2 (GitHub issues; acceptance criteria there are authoritative)
- [x] **#129 · 2.1** Carrier provider interface + EasyPost (test mode) — done, PR #175 in review
- [ ] **#130 · 2.2** Rate shopping at checkout
- [ ] **#131 · 2.3** Labels and tracking webhooks
- [ ] **#132 · 2.4** 3PL adapter interface + in-memory implementation
- [ ] **#133 · 2.5** Pick/pack state machine and events

## Decisions made (with reasons)
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
- 2.3 needs the shared `webhook_event` table. Window 7 files the CONTRACT CHANGE (one issue, not two) — check
  its state before starting 2.3.

## Gotchas learned
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
