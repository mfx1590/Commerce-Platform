# shipping (window 8)

Carrier abstraction of the commerce core: rates, labels, voids, tracking and address validation behind one
interface, with an in-memory `manual` provider and an EasyPost provider (test mode). Phase 2 tasks 2.2 (rate
shopping at checkout) and 2.3 (labels and tracking webhooks) build on this module; the 3PL side is
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
- `easypost-live.test.ts` — real round trip against EasyPost **test mode**: quote, buy, track, void, validate.
  Skips unless `EASYPOST_API_KEY` is set, and refuses a non-test key. Uses EasyPost's documentation addresses,
  so no customer data ever leaves the machine.

`pnpm --filter @platform/core test` runs them; the workspace packages must be built first
(`pnpm turbo run build --filter=@platform/db …`), as `apps/core/CLAUDE.md` describes.

## Next in this module

2.2 plugs `rates()` into core's `ShippingRateProvider` seam (`setShippingRateProvider` from
`src/modules/cart`) with the `shipping_option` table as the fallback when a carrier is down; 2.3 writes
`shipment` / `shipment_item` rows and their outbox events, and receives tracking webhooks.
