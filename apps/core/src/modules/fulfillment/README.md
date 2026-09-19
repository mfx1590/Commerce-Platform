# fulfillment (window 8)

The 3PL boundary of the commerce core: which warehouse ships an order, handing the request to that warehouse's
fulfilment provider, cancelling it, and keeping the shipment in step with what the provider reports (issue #132).
Carriers, labels and tracking are the sibling `shipping` module; this module builds on its public API.

## Owner

Window 8 (shipping). Paths: `apps/core/src/modules/fulfillment/**`. The warehouse side — stock-aware allocation,
split orders, the WMS itself — is window 11's in Phase 3.

## Public API (`index.ts`)

| Export                                                                          | What it does                                                                |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `requestFulfillment(client, { orderId, items?, warehouseId?, actor })`          | route, plan the shipment, push it to the provider                           |
| `cancelFulfillment(client, shipmentId, actor)`                                  | ask the provider to stop; on yes, cancel the shipment and release its stock |
| `applyFulfillmentUpdate(client, update, actor)`                                 | apply what the provider reports (push callback or `status()` poll)          |
| `routeFulfillment`, `routingSettingsFrom`, `regionOf`                           | the pure routing rules                                                      |
| `FulfillmentProvider`, `createMemoryFulfillmentProvider`                        | the provider interface and the in-memory 3PL                                |
| `setFulfillmentProvider`, `fulfillmentProviderFor`, `resetFulfillmentProviders` | the provider registry                                                       |

## Routing

`routeFulfillment` picks one warehouse from the organization's active ones. The first rule that matches wins:

| #   | Rule                                       | Source                                                            |
| --- | ------------------------------------------ | ----------------------------------------------------------------- |
| 1   | store override for the destination country | `store.settings.fulfillment.routing.countries[CC]`                |
| 2   | store default                              | `store.settings.fulfillment.routing.default`                      |
| 3   | a warehouse in the destination country     | `warehouse.country`                                               |
| 4   | a warehouse in the destination's region    | static map in `routing.ts` (Europe incl. GB/CH/NO; North America) |
| 5   | the lowest `priority`, then `code`         | `warehouse.priority`                                              |

Store settings name warehouses by `code` (`wh-eu`), not id, so a human can read them. A code that names no active
warehouse is ignored rather than failing the order. The decision carries the rule that won (`routing.rule`), so
the admin can show why an order went where it did.

With the seed: an order to NL goes to `wh-eu` by country, DE/FR/BE/GB by region; US to `wh-us` by country, CA/MX
by region; anything else to `wh-eu` by priority.

```json
{
  "fulfillment": {
    "provider": "memory",
    "routing": { "countries": { "DE": "wh-us" }, "default": "wh-eu" }
  }
}
```

Stock-aware allocation — splitting an order across warehouses by what is on the shelf — is window 11's in Phase 3.
Until then one order goes to one warehouse.

## Requesting and cancelling: no transaction across a provider call

A 3PL can take seconds or time out, and a database transaction held that long pins a connection and the order
row's locks. So each flow is short transactions around the network call, with an explicit compensation:

| Flow                 | Steps                                                                                                                                                    | When a later step fails                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `requestFulfillment` | plan the shipment (one tx: rows, `shipment.created`, reservation consumed) → push (no tx) → record the reference on `shipment.metadata.fulfillment` (tx) | a failed push cancels the shipment, which releases its stock; the call is a 502 and the order is as it was |
| `cancelFulfillment`  | ask the provider (no tx) → cancel the shipment (tx: stock released)                                                                                      | the provider refuses once picking has started: 409, nothing changes                                        |

`items` defaults to everything the order still owes, counting earlier live shipments; nothing owed is a 409.

## Provider updates

`applyFulfillmentUpdate` is idempotent — a state the shipment already records changes nothing — and checks that the
update's external id belongs to the shipment it names.

| Provider state                  | Effect                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| `accepted`, `picking`, `packed` | recorded on `shipment.metadata.fulfillment` only; task 2.5 adds the pick/pack state machine |
| `shipped`                       | shipment → `shipped` with the tracking number (then the order records fulfilment)           |
| `cancelled`                     | shipment → `cancelled` (stock released)                                                     |
| `failed`                        | shipment → `failed`                                                                         |

A 409 from the shipment on these moves is ignored: the carrier's tracking webhook may have got there first, and the
provider is simply late.

## The in-memory provider

`createMemoryFulfillmentProvider()` is registered as `memory` by default, so a local run and every test work with no
configuration. It behaves like a real 3PL where it matters: forward-only progress, a free cancel only before
picking, tracking required to ship, and `failNextPush()` to exercise the compensation. **It forgets every job on
restart** — which is why it is called `memory` rather than anything that sounds production-ready.

## Mapping for a real 3PL

A real provider implements `FulfillmentProvider` and is registered at boot with `setFulfillmentProvider`. This is
the mapping to the shape most 3PL APIs share (order, line items, ship-to, status webhooks):

| Ours                                                                          | Typical 3PL field                                                                | Notes                                                                     |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `FulfillmentRequest.reference` (our shipment id)                              | order `reference` / `external_order_id`                                          | echoed on every webhook, so no lookup table                               |
| `warehouseCode`                                                               | `fulfillment_center` / `warehouse_id`                                            | map our codes to theirs in the provider                                   |
| `lines[].sku`, `quantity`                                                     | line items `sku`, `quantity`                                                     | the 3PL holds its own SKU master                                          |
| `shipTo`                                                                      | `shipping_address`                                                               | goes to the 3PL because it must; never logged or put in an error          |
| `carrier`, `service`                                                          | `shipping_method` / `carrier_service`                                            | from the order's frozen `shipping_method`                                 |
| `push`                                                                        | `POST /orders`                                                                   | `FulfillmentError` with `retryable` on 5xx/429/timeouts                   |
| `status`                                                                      | `GET /orders/{id}`                                                               | pull fallback when webhooks are missed                                    |
| `cancel`                                                                      | `POST /orders/{id}/cancel`                                                       | return `{ cancelled: false, reason }` when the 3PL says it is too late    |
| states `accepted` / `picking` / `packed` / `shipped` / `cancelled` / `failed` | e.g. `processing` / `picking` / `packed` / `shipped` / `cancelled` / `exception` | normalise in the provider; anything unknown should not advance a shipment |

A provider webhook receiver should follow `shipping/tracking.ts`: verify the signature over the raw body, record the
event id in `webhook_event` (migration 0140), then call `applyFulfillmentUpdate`.

## Tests

- `routing.test.ts` — every rule in order, the store override and default, malformed settings (10 tests).
- `memory-provider.test.ts` — progression, cancel refusal after picking, push failure, the registry (6 tests).
- `fulfillment-db.test.ts` — on a seeded database: EU order to `wh-eu`, US order to `wh-us`, store override, cancel
  before pick releasing stock through the real inventory module, cancel after pick refused, failed push compensated,
  the provider's `shipped` moving the shipment and the order (9 tests).

## Next

Task 2.5 turns `picking` and `packed` into a pick/pack state machine with events and admin operations.
