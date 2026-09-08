# Changelog — shipping module (window 8)

The app-level `apps/core/CHANGELOG.md` and the module row in `apps/core/CLAUDE.md` belong to window 1; this
file is the module's own history (linked from the PRs).

## Phase 2 — shipping/phase2 (contracts-v0.3)

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
