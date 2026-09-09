# shipping (window 8)

Carrier abstraction of the commerce core: rates, labels, voids, tracking and address validation behind one
interface, with an in-memory `manual` provider and an EasyPost provider (test mode), plus the rate shopping the
cart calls at checkout. Task 2.3 (labels and tracking webhooks) builds on this module; the 3PL side is
`apps/core/src/modules/fulfillment` (task 2.4).

## Owner

Window 8 (shipping). Paths: `apps/core/src/modules/shipping/**`, `apps/core/src/modules/fulfillment/**`
(docs/ownership.md). Contracts: `contracts-v0.3`.

## Public API (`index.ts`)

| Export                                                                                                                    | What it does                                                              |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `CarrierProvider` (type)                                                                                                  | `rates` · `buyLabel` · `voidLabel` · `track` · optional `validateAddress` |
| `manualCarrierProvider`, `createManualCarrierProvider`, `DEFAULT_MANUAL_CONFIG`                                           | the built-in in-memory carrier                                            |
| `createEasyPostProvider`, `EASYPOST_BASE_URL`                                                                             | EasyPost over `fetch`, test mode only                                     |
| `easyPostTrackingStatus`, `trackingEventOf`                                                                               | tracker mapping, reused by the 2.3 webhook receiver                       |
| `setCarrierProvider`, `carrierProvider`, `carrierProviderOrManual`, `registeredCarrierProviders`, `resetCarrierProviders` | process-wide provider registry                                            |
| `easyPostCredentialsFor`, `isTestModeKey`, `envSuffix`                                                                    | per-store credentials from the environment (ADR 0006)                     |
| `carrierConfigFor`, `DEFAULT_PARCEL`                                                                                      | per-store carrier settings from `store.settings.shipping`                 |
| `toCarrierAddress`, `redactAddress`, `CarrierError`, `isRetryableStatus`                                                  | address conversion, redaction, the one error providers throw              |
| `toMinorUnits`, `fromMinorUnits`, `currencyExponent`                                                                      | carrier decimal strings ⇄ integer minor units                             |

Money is always an integer in minor units of an explicit currency; nothing in this module is a float.

## Providers

### `manual`

A store that prints its own labels. Prices come from a table (`ManualCarrierConfig`): a flat base plus a charge
per **started** kilogram, one set of services per zone (`domestic` when origin and destination country match,
otherwise `international`). Every id is a sha1 of its inputs, so the same request always produces the same rate
id, shipment id and tracking number, and tests assert on exact values. Bought labels live in a `Map` for the
lifetime of the process: buying the same rate twice for the same shipment reference returns the first label
rather than a second parcel. `advanceTracking(shipmentId, status)` records a scan — the fixture task 2.3's
webhook tests replay. `rates()` in a currency the table is not priced in returns `[]`, never a converted price.

### `easypost`

One HTTP shape over the global `fetch`, no SDK. `createEasyPostProvider({ apiKey })` **refuses a live key**
(`EZAK…`) unless `allowLiveKey` is passed, which nothing in Phase 2 does: this phase buys test labels only.

- Units: we store centimetres and grams, EasyPost wants inches and ounces — converted on the way out.
- Currency: a rate quoted in a currency other than the requested one is dropped, never converted. There is no
  FX in the core.
- Buying a label needs the EasyPost _shipment_, not just the rate: the provider remembers the mapping from
  `rates()`. Across processes, pass `providerShipmentId` on `buyLabel`.
- Tracker statuses map onto our `TrackingStatus`; anything unrecognised stays `unknown` rather than being
  guessed at. `trackingEventOf` falls back to `<tracking>:<datetime>:<status>` when a detail has no id, so the
  2.3 webhook receiver always has an idempotency key.
- **Retries.** A _safe_ call — rates, track, address validation — is attempted up to `maxAttempts` times (3 by
  default) while EasyPost answers a retryable status (0, 408, 429, 5xx), with the delay doubling from 200 ms.
  **Buying and voiding a label are never retried**: a 5xx can arrive after the label was created, and a second
  attempt would buy a second parcel. Callers see the last `CarrierError`.
- The rate → shipment index it keeps for `buyLabel` is bounded and expiring (500 entries, 30 minutes); pass
  `providerShipmentId` when buying later than that.

## Rate shopping (task 2.2)

`createCarrierRateProvider()` implements the cart module's `ShippingRateProvider`. The division of labour is the
point:

- **The `shipping_option` table decides what exists.** Which options a store offers, who is eligible, and the
  id, code, name and carrier of each. Checkout freezes exactly that row on the order (`shipping_method`), so a
  rate this module invented would be unplaceable. Option ids are therefore always real table rows.
- **The carrier decides what a live option costs.** A row opts in with `rules.live = true` and a `service`; its
  price then comes from the carrier rate whose carrier and service match. Everything else keeps its flat
  `price_minor`.

### `rules` on a `shipping_option`

`rules` is a free-form jsonb column. `min_subtotal_minor` and `max_weight_g` are the keys docs/domain.md names;
`free_over_subtotal_minor` and `live` are this module's additions to the same column (no schema change).

| Key                        | Effect                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------- |
| `min_subtotal_minor`       | the option is offered only from this cart subtotal up                               |
| `max_weight_g`             | the option is offered only up to this parcel weight                                 |
| `free_over_subtotal_minor` | at or above this subtotal the option costs 0, applied after pricing                 |
| `live`                     | `true` = price from the carrier (needs `service`); otherwise the flat `price_minor` |

### What the provider reads, and from where

All of it through the cart's own transaction, so RLS keeps it inside the store: the eligible `shipping_option`
rows, the store's `code` and `settings`, an active `warehouse` for the origin (destination country first, then
`priority` — task 2.4 replaces this with real routing), and `product_variant.weight_g` for the parcel weight (a
variant with no weight counts as 500 g).

### When the carrier does not answer

Every option falls back to its flat table price, and the cart prices normally. That covers a provider error, a
timeout, a rate limit past its retries, no credentials for the store, no warehouse with a usable address, a cart
with no shipping address yet, and a carrier that quotes nothing in the cart's currency. **There is no FX**: a
rate in another currency is dropped, never converted. The fallback is reported through `onFallback` (default: one
`console.warn`) with the store id, destination country, provider, status and reason — never an address.

### Caching

Carrier quotes are cached for 60 seconds per identical cart: provider, store, currency, origin, parcel, service
set, carrier accounts, and a **sha256 of the destination** — an address never sits in a process index in readable
form. The cache and the resolved per-store providers are `BoundedTtlMap`s, so neither grows without bound.

### Boot

`registerCarrierProviders()` is the mount point: `src/server.ts` calls it once at start-up (REQUEST #176 to
window 1) and it installs the provider through `setShippingRateProvider`. This module never edits the cart. With
no credentials and no store settings the behaviour is exactly today's flat table rates, so the call is safe
before any store opts in.

## Credentials (ADR 0006)

`EASYPOST_API_KEY_<CODE>` for one store (`brand-a` → `BRAND_A`), else the global `EASYPOST_API_KEY`; neither set
means the store runs on `manual`. Locally the values come from the repo-root `.env`; in a deployed environment
from `<env>/stores/<store_code>/easypost` in Secrets Manager, delivered as environment variables by External
Secrets. The key is used as the Basic-auth user and is never logged, never put in an error and never returned.
`.env.example` does not list these variables yet — root config belongs to the main window (REQUEST #173).

## Per-store settings

`store.settings.shipping`, read by `carrierConfigFor` (every field optional; a mistyped field falls back to its
default rather than throwing, so a store still checks out):

```jsonc
"shipping": {
  "provider": "easypost",            // registry name; default "manual"
  "carrier_account_ids": ["ca_123"], // provider-side accounts to shop
  "services": ["UPSGround"],         // restrict shopping; empty = all
  "default_parcel": { "length_cm": 30, "width_cm": 20, "height_cm": 10, "weight_g": 1000 },
  "label_format": "pdf"              // pdf | png | zpl
}
```

## Addresses and logs

An address is passed to a carrier and to nothing else. `redactAddress` returns country, region and the first two
characters of the postal code — a routing zone — and is the only shape allowed in a log, an event payload or a
support note. `CarrierError` carries the provider, operation, HTTP status and the carrier's own message, never
the request that produced it, so a stack trace logged upstream cannot leak an address or a key. Label artefacts
are held as URLs; no PDF bytes are stored or passed around.

## Registry

`manual` is built in. Other providers register at boot (`setCarrierProvider(createEasyPostProvider({ apiKey }))`)
and are resolved by the name in a store's settings; `carrierProviderOrManual` never fails, which is what task
2.2's fallback path relies on. `resetCarrierProviders()` is for tests.

## Tests

- `manual-provider.test.ts` — pricing table, started-kilogram rounding, zones, determinism, label idempotency,
  void rules, tracking, address validation (14 tests).
- `easypost-provider.test.ts` — request shaping against a fake fetch: auth header, unit conversion, currency
  filtering, buy/void/track/validate mapping, error redaction, timeout and network failure (14 tests).
- `shipping.test.ts` — credentials, store settings, minor-unit conversion, redaction, registry (20 tests).
- `rate-shopping.test.ts` — the merge of table rules and carrier prices against a stubbed transaction: live
  pricing, every fallback path, thresholds, eligibility, weights, sorting, caching, currency mismatch (16 tests).
- `rate-shopping-db.test.ts` — the real SQL on a seeded database, and placement through the cart and checkout
  public APIs: the live price is frozen on the order as `shipping_method` (6 tests).
- `bounded-map.test.ts` — expiry, cap and eviction order (6 tests).
- `easypost-live.test.ts` — real round trip against EasyPost **test mode**: quote, buy, track, void, validate.
  Skips unless `EASYPOST_API_KEY` is set, and refuses a non-test key. Uses EasyPost's documentation addresses,
  so no customer data ever leaves the machine.

`pnpm --filter @platform/core test` runs them; the workspace packages must be built first
(`pnpm turbo run build --filter=@platform/db …`), as `apps/core/CLAUDE.md` describes.

## Next in this module

2.3 writes `shipment` / `shipment_item` rows and their outbox events and receives tracking webhooks (the shared
`webhook_event` table is being coordinated with window 7 on issue #125); 2.4 adds the 3PL adapter and real
per-warehouse routing, which replaces the origin-warehouse pick used here.
