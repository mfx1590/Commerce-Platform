# Changelog — shipping module (window 8)

The app-level `apps/core/CHANGELOG.md` and the module row in `apps/core/CLAUDE.md` belong to window 1; this
file is the module's own history (linked from the PRs).

## Phase 2 — shipping/phase2 (contracts-v0.3)

### 2026-09-19 · 2.5 Status machine widened, and the review fixes (#133, CONTRACT CHANGE #225)

- `shipment.status` gains `picking` and `packed` (#225, migration 0160 widens the column's CHECK; both database
  suites apply `../fulfillment/proposed/0160_shipment_pick_pack.sql` until it lands). Cancel is legal from
  `pending`, `picking`, `packed` and `label_created`. The moves themselves live in the `fulfillment` module.
- `buyShipmentLabel` no longer calls the carrier inside a transaction: read, then quote and buy with nothing
  held, then record. A shipment that moved meanwhile makes the call a 409 and the bought label is voided again
  rather than orphaned at the carrier.
- `verifyEasyPostSignature` accepts only the `hmac-sha256-hex` label or a bare digest; a correct digest under
  `sha1=` or `v0=` is refused.
- A tracking number matching two shipments is ambiguous: the delivery is recorded and skipped with a reason, and
  neither shipment moves.
- `loadShipment` is exported for the fulfillment module's lifecycle.
- Tests: the label-void race, the signature labels, the tracking collision, the new ranks, and a two-shipment
  order replayed from its own outbox stream back into the order the database holds.

### 2026-09-15 · 2.3 review fixes (#218)

- **`webhook_event` now matches #187 exactly.** `proposed/0140_webhook_event.sql` is a byte-for-byte copy of #187's
  SQL (identical to payments' copy; a test fails on drift) and only the test suite applies it. The store is
  rewritten against it: `provider_event_id`, `event_type`, `provider_object_id`, `aggregate_type` / `aggregate_id`,
  status `received → processed | skipped | failed`, `failure_reason`, `store_id NOT NULL`, RLS. The earlier draft
  (`external_id`, `topic`, `error`, `ignored`, nullable store, no hash) would have failed every delivery once 0140
  landed. The in-memory event store and `PROPOSED_WEBHOOK_EVENT_SQL` are gone.
- **No raw carrier body is stored.** `extractEasyPostWebhook` reduces a delivery to provider event id, event type,
  tracker id, tracking code, carrier, status and the carrier timestamp; addresses, recipient names and scan
  locations are dropped. `payload_hash` is the sha256 of the raw request body. The carrier timestamp is `null` when
  absent — no more 1970 placeholder — and a transition then uses receipt time.
- **Routers shipped.** `shippingWebhookRouter()` (`POST /webhooks/easypost/:storeCode`, `express.raw`, store
  resolved before anything is stored, per-store `EASYPOST_WEBHOOK_SECRET_<CODE>`) and `shippingAdminRouter()`
  (`createShipment`, `updateShipment` with `permission(operationId)` and body validation from `admin-api.yaml`),
  exported from `index.ts`; mount lines posted on #176. Result outcome `ignored` is renamed `skipped`.

### 2026-09-08 · 2.3 Labels, shipments and tracking webhooks (#131)

- `shipments.ts` (new): `createShipment` (validates against what the order still owes, inserts `shipment` +
  `shipment_item`, consumes reservations, refreshes the order's fulfilment status, emits `shipment.created` — one
  transaction), `buyShipmentLabel` (idempotent; a carrier failure is a 502 and the shipment stays `pending`),
  `updateShipment` / `applyTransition` (the only writer of a shipment's status), `getShipment`,
  `listOrderShipments`, `renderShipment` (the Admin API `Shipment` shape; Postgres timestamps rendered as ISO).
- Status machine: `pending` to `label_created` to `shipped` to `in_transit` to `delivered`, forward only, with
  `delivered` / `failed` / `cancelled` terminal. An illegal transition on the admin route is a 409; the same one
  from a carrier scan is ignored. A shipment that jumps straight to `delivered` still emits `shipment.shipped`
  first, because accounting derives shipping cost and COGS timing from it.
- `tracking.ts` (new): `handleEasyPostWebhook` — verify the HMAC over the **raw** body (timing-safe, 401 on
  anything wrong), record the provider event id, then apply. `applyTrackingEvent` is the provider-independent
  half; `parseEasyPostWebhook` reads the tracker's current state rather than the last detail, since EasyPost
  resends the whole history. Results are `applied` / `duplicate` / `ignored`.
- `webhook-events.ts` (new): the shared idempotency record. `UNIQUE (provider, external_id)` — not a global
  unique id — and a nullable `occurred_at` separate from `received_at`, so out-of-order scans are ordered by the
  carrier's clock. The table is window 7's CONTRACT CHANGE (#125) and is not in db 0.2.0 yet:
  `PROPOSED_WEBHOOK_EVENT_SQL` is what this module builds and tests against meanwhile.
- `ports.ts` (new): how shipping reaches the modules it does not own, on the functions agreed on #191 — orders
  `markShipmentCreatedInTx` / `markShippedInTx` / `markDeliveredInTx`, inventory `consumeReservationsForShipment`
  / `releaseReservationsForShipment`. All run on shipping's transaction. Orders calls are advisory (a 409 from the
  order's state machine is reported, never thrown, inside a SAVEPOINT so a refusal leaves no partial rows);
  inventory calls are not. **Behaviour change: fulfilment is recorded on despatch, not on plan** — planning only
  moves the order to `processing`. An earlier local draft used a transaction adapter over the client-taking
  functions and a no-op inventory mirror; both are gone.
- Events: `shipment.created`, `shipment.shipped`, `shipment.delivered` v1, all through `withEvents` in the same
  transaction as the state change, all carrying ids, amounts and a destination country — never an address.
- Tests: 21 unit tests (signatures, parsing, transitions) and 15 on a seeded database, including duplicate
  deliveries, delivered-before-shipped, partial shipments and a cancel releasing the reservation.

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

## 2026-09-19 — migration 0140 landed (contracts-v0.4.2, manager)

- `proposed/0140_webhook_event.sql` and the byte-drift test against payments' copy deleted; `webhook_event` now comes from `@platform/db` migration 0140 (db 0.3.0). `shipments-db.test.ts` no longer applies the DDL itself.
