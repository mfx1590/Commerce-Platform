# Changelog — shipping module (window 8)

The app-level `apps/core/CHANGELOG.md` and the module row in `apps/core/CLAUDE.md` belong to window 1; this
file is the module's own history (linked from the PRs).

## Phase 2 — shipping/phase2 (contracts-v0.3)

### 2026-09-08 · 2.2 Rate shopping at checkout (#130)

- `rate-shopping.ts` (new): `createCarrierRateProvider()` implements the cart module's `ShippingRateProvider`.
  The `shipping_option` table decides which options exist and who is eligible (so an option id is always a real
  row and checkout can freeze it on the order); a row with `rules.live = true` and a `service` is priced by the
  carrier instead of its flat `price_minor`. Reads the options, the store's code and settings, an origin
  warehouse and `product_variant.weight_g` through the cart's own transaction (RLS scope = the store).
- `rules` keys: `min_subtotal_minor` and `max_weight_g` (eligibility, from docs/domain.md),
  `free_over_subtotal_minor` (free shipping threshold, applied after pricing) and `live`. All optional, all
  ignored when unreadable — a mistyped rule never fails a quote. No schema change: `rules` is jsonb.
- Fallback: a provider error, timeout, exhausted retry, missing credential, missing warehouse, missing shipping
  address or a quote in the wrong currency puts every option back on its flat table price. A carrier outage
  cannot stop a cart from pricing, and there is no FX anywhere.
- Carrier quotes are cached 60 s per identical cart. The key hashes the destination (sha256), so an address is
  never held in a process index in readable form.
- `registerCarrierProviders()` is the boot mount point `src/server.ts` calls (REQUEST #176 to window 1); this
  module never edits the cart. Safe before any store opts in: with no credentials the behaviour is today's.
- A provider registered with `setCarrierProvider` now wins over building one from a store's credentials — the
  registry is the extension point, and `easypost` cannot be a single entry because its keys are per store.
- `bounded-map.ts` (new): `BoundedTtlMap`, entries expiring on a TTL with a hard cap and oldest-first eviction.
  The EasyPost rate → shipment index (500 / 30 min), the manual provider's quotes (500 / 30 min) and labels
  (1000 / 24 h) and the rate cache all use it — no in-process index in this module grows without bound.
- EasyPost retries: a _safe_ call (rates, track, address validation) is attempted up to `maxAttempts` (default 3)
  while the status is retryable, with the delay doubling from 200 ms. **Buying and voiding a label are never
  retried** — a 5xx can arrive after the label exists, and a retry would buy a second parcel.
- Tests: 22 more unit tests (rate shopping, bounded map, retries) plus `rate-shopping-db.test.ts` — 6 tests on a
  seeded database including placement through the cart and checkout public APIs, proving the live price is
  frozen on the order as `shipping_method`.

### 2026-09-08 · 2.1 Carrier provider interface + manual and EasyPost providers (#129)

- `types.ts`: `CarrierProvider` (`rates`, `buyLabel`, `voidLabel`, `track`, optional `validateAddress`) with
  `CarrierAddress`, `Parcel` (centimetres and grams), `CarrierRate`, `CarrierLabel`, `TrackingEvent`,
  `TrackingStatus`, `AddressValidation` and `StoreCarrierConfig`. Every amount is an integer in minor units of an
  explicit currency; label artefacts are URLs, never bytes.
- `manual-provider.ts`: the built-in in-memory carrier. Table pricing (flat base + per started kilogram, one
  service set per domestic/international zone), sha1-derived ids so rates, shipment ids and tracking numbers are
  deterministic, label purchase idempotent per rate + shipment reference, `voidLabel` refused once the parcel has
  moved, `advanceTracking` to record scans for later tests, a cheap address check. `createManualCarrierProvider`
  takes its own price table and provider name.
- `easypost-provider.ts`: EasyPost over the global `fetch` (no SDK). Basic auth with the API key as user; cm→in
  and g→oz conversion; rates in another currency than requested are dropped, never converted; buy remembers the
  EasyPost shipment a rate belongs to (or takes `providerShipmentId`); refund, tracker mapping and strict address
  verification. **Refuses a live key (`EZAK…`) unless `allowLiveKey` is set** — Phase 2 is test mode only.
  `trackingEventOf` / `easyPostTrackingStatus` are exported for the 2.3 webhook receiver, with a synthetic event
  id when a tracker detail has none.
- `registry.ts`: process-wide provider registry, the same shape as the checkout module's payment registry.
  `manual` is built in; `carrierProviderOrManual` never fails (2.2's fallback path).
- `config.ts`: per-store credentials from the environment (ADR 0006) — `EASYPOST_API_KEY_<CODE>` over the global
  `EASYPOST_API_KEY`, reporting the variable name and never the value — and `carrierConfigFor`, which reads
  `store.settings.shipping` field by field with a default for anything missing or mistyped.
- `redact.ts`: `toCarrierAddress` (contract shape → carrier shape), `redactAddress` (country, region, two-character
  postal prefix — the only address shape allowed in a log or an event), `CarrierError` (provider, operation,
  status, carrier message; never the request payload) and `isRetryableStatus`.
- `money.ts`: `toMinorUnits` / `fromMinorUnits` over the decimal _string_ (no float), rounding half away from zero
  at the currency's exponent, with the ISO-4217 zero- and three-decimal currencies.
- Tests: 48 unit tests plus a live EasyPost round trip that skips without `EASYPOST_API_KEY` and refuses a
  non-test key.
