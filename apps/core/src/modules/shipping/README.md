# shipping (window 8)

Carrier abstraction of the commerce core: rates, labels, voids, tracking and address validation behind one
interface, with an in-memory `manual` provider and an EasyPost provider (test mode); the rate shopping the cart
calls at checkout; and shipments — planning them from an order, buying labels, and the tracking webhook that
moves them. The 3PL side is `apps/core/src/modules/fulfillment` (task 2.4).

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
| `createShipment`, `buyShipmentLabel`, `updateShipment`, `getShipment`, `listOrderShipments`                               | shipments and their state machine (task 2.3)                              |
| `handleEasyPostWebhook`, `applyTrackingEvent`, `extractEasyPostWebhook`, `verifyEasyPostSignature`                        | the tracking webhook receiver                                             |
| `shippingWebhookRouter`, `shippingAdminRouter`                                                                            | the mountable routers (see HTTP below)                                    |
| `recordWebhookEvent`, `finishWebhookEvent`, `payloadHashOf`                                                               | the `webhook_event` row (#187)                                            |
| `easyPostWebhookSecretFor`                                                                                                | per-store tracking webhook secret from the environment                    |

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

## Shipments (task 2.3)

`createShipment` plans one from an order: it checks the requested quantities against what the order still owes
(earlier live shipments counted), inserts `shipment` + `shipment_item`, consumes the reservations, refreshes the
order's fulfilment status and emits `shipment.created` — one transaction, so the rows and the event commit
together or not at all (ADR 0003). `buyShipmentLabel` then asks the store's carrier for a label and moves the
shipment to `label_created`; it is idempotent (a shipment that already has a label is returned unchanged) and a
carrier failure is a 502 that leaves the shipment `pending` and retryable.

### Status machine

```
pending -> label_created -> shipped -> in_transit -> delivered
   |             |             \---------------------> delivered   (carrier skipped the scans)
   \-------------/--> cancelled                \----> failed
```

Forward only, and `delivered` / `failed` / `cancelled` are final. An illegal transition through the admin route
is a 409; the same transition arriving from a carrier scan is **skipped**, because carriers deliver events out of
order and a late `in_transit` after `delivered` is normal, not an error.

A shipment that jumps straight to `delivered` still emits `shipment.shipped` first: accounting derives shipping
cost and COGS timing from that event and must never miss it.

### What the order and the stock hear

Shipping encodes neither the order state machine nor the reservation rules. It reports facts to window 1's
modules through the functions agreed on #191, all on shipping's own transaction — so the shipment rows, their
events, the order's status and the stock movements commit together or not at all.

| When                                    | Orders module                                                     | Inventory module                 |
| --------------------------------------- | ----------------------------------------------------------------- | -------------------------------- |
| a shipment is planned                   | `markShipmentCreatedInTx` (`confirmed` to `processing`)           | `consumeReservationsForShipment` |
| it reaches `shipped` (or jumps past it) | `markShippedInTx` with the line quantities                        | —                                |
| it reaches `delivered`                  | `markDeliveredInTx` (`processing` to `completed`, once fulfilled) | —                                |
| a planned shipment is cancelled         | —                                                                 | `releaseReservationsForShipment` |

Both inventory functions are idempotent per shipment on window 1's side, so a retry never double-decrements.

**Orders calls are advisory.** An order nobody has confirmed refuses `processing`, and delivery before every line
has shipped refuses `completed`. That 409 must not fail the shipment or make a carrier retry its webhook for ever,
so it is reported in the outcome instead of thrown. Each call runs inside a `SAVEPOINT`, and a refusal rolls back
to it: a call that wrote some rows before refusing leaves nothing behind. **Inventory calls are not advisory** — a
stock failure is a real failure and rolls the shipment back.

**Behaviour to know: fulfilment is recorded on despatch, not on plan.** Planning a shipment only moves the order
to `processing`; `fulfilled_quantity` and `fulfillment_status` change when the shipment reaches `shipped`.

## Tracking webhooks (task 2.3)

`handleEasyPostWebhook` does four things in this order, and the order is the design:

1. **Verify first.** HMAC-SHA256 over the **raw** body, compared timing-safely. A missing, malformed or wrong
   signature is a 401, and nothing is stored — anything else would let a stranger drive our shipment states.
2. **Extract, don't store.** The raw body is hashed (`payload_hash`, sha256 hex of the exact bytes) and reduced to
   the fields shipping processes: provider event id, event type, tracker id, tracking code, carrier, status and the
   carrier's timestamp. Addresses, recipient names and scan locations are dropped at extraction and never reach a
   row, an event or a log.
3. **Record before applying.** The extract goes into `webhook_event` in the same transaction as the state change. A
   carrier retry conflicts on `UNIQUE (provider, provider_event_id)` and returns `duplicate` without touching a
   shipment or emitting a second event.
4. **Move forward only.** Ordering comes from the shipment's own state machine, never from the carrier's timestamp.

The result is `applied`, `duplicate` or `skipped` (unknown tracking number, unmapped carrier status, or a scan the
shipment is already past). A failure while applying rolls the row back with the change, so the carrier's retry
processes the event again instead of finding it "already seen".

### The shared `webhook_event` table (#187)

Landed as migration **0140** in `@platform/db` (db 0.3.0, contracts-v0.4.2), shared with payments.

| Column                                             | What shipping writes                                                          |
| -------------------------------------------------- | ----------------------------------------------------------------------------- |
| `provider`, `provider_event_id`                    | `easypost`, the webhook's `evt_…` id — the dedupe key                         |
| `event_type`, `provider_object_id`                 | `tracker.updated`, the tracker `trk_…`                                        |
| `store_id`                                         | resolved by the router from the path before anything is stored                |
| `occurred_at`                                      | the carrier's timestamp from the payload, **null when the carrier sent none** |
| `status`                                           | `received`, then `processed` or `skipped`                                     |
| `aggregate_type`, `aggregate_id`, `failure_reason` | `shipment` and its id once resolved; why it was skipped                       |
| `payload`                                          | the redacted extract above — never the raw body                               |
| `payload_hash`                                     | sha256 hex of the raw request body                                            |

A shipment moved by a scan with no carrier timestamp uses receipt time, never a placeholder date.

## HTTP (task 2.3)

Two routers in `http.ts`, exported from `index.ts`. Mounting them is window 1's one line each (REQUEST #176):

```ts
app.use(shippingWebhookRouter()); // mountCoreMiddleware, before coreErrorHandler, outside /store and /admin
routers.push(shippingAdminRouter()); // src/http/module-routers.ts, after adminRouter()
```

| Route                                                   | Authentication                                       | Notes                                                                                                                              |
| ------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `POST /webhooks/easypost/:storeCode`                    | HMAC over the raw body (`X-Hmac-Signature`)          | `express.raw`, 512 KB limit; unknown store 404; no secret configured 503 naming the missing variable; 200 with `outcome` otherwise |
| `POST /admin/stores/:storeId/orders/:orderId/shipments` | staff principal + `x-permission` of `createShipment` | body validated against the spec; 201 `Shipment`                                                                                    |
| `PATCH /admin/shipments/:shipmentId`                    | staff principal + `x-permission` of `updateShipment` | the path names no store, so the shipment's store is resolved and a client scoped to it is used; illegal transition 409             |

Permissions are read from `admin-api.yaml` through `loadSpec(...).permission(operationId)` — never hard-coded. The
webhook secret is `EASYPOST_WEBHOOK_SECRET_<CODE>`, else `EASYPOST_WEBHOOK_SECRET`; `.env.example` has no row for
it yet (root config, main window).

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
- `tracking.test.ts` — signature verification, redacted extraction (no PII survives), the raw body hash and every
  transition rule (24 tests).
- `shipments-db.test.ts` — on a seeded database with #187's DDL: planning against a real placed order, over-shipping
  refused, label purchase and its idempotency, one event per transition, delivered-before-shipped, real inventory
  consume and release; the `webhook_event` row (redacted extract, raw-body hash, skipped outcomes, null carrier
  timestamp), byte-equality with payments' copy of the DDL; the webhook router (raw body, 401/404/503) and the
  admin router (403 without the operation's permission, 400 on a body the spec refuses, 409, 404) (22 tests).
- `easypost-live.test.ts` — real round trip against EasyPost **test mode**: quote, buy, track, void, validate.
  Skips unless `EASYPOST_API_KEY` is set, and refuses a non-test key. Uses EasyPost's documentation addresses,
  so no customer data ever leaves the machine.

`pnpm --filter @platform/core test` runs them; the workspace packages must be built first
(`pnpm turbo run build --filter=@platform/db …`), as `apps/core/CLAUDE.md` describes.

## Next in this module

2.4 adds the 3PL adapter in `apps/core/src/modules/fulfillment` and real per-warehouse routing, which replaces the
single origin-warehouse pick used here; 2.5 adds the pick/pack lifecycle in front of `shipped`.
