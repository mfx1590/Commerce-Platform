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
  the provider's states moving the shipment, the divergence record when a provider cancels what we cannot, and the
  reference that stays put when a move fails (11 tests).
- `lifecycle-db.test.ts` — pick and pack on a seeded database: the two moves and their events, skips, refusals,
  parcel counts, the pick list (grouping, filters, paging), and the router with dev tokens including the
  cross-organization 404 (11 tests).

## The pick/pack lifecycle (task 2.5, CONTRACT CHANGE #225)

Pick and pack are **`shipment.status` values**, not a second state on the side: one column every guard, listing
and consumer reads. `pickShipment` and `packShipment` move a shipment forward and write one event each, in the
same transaction as the move.

```
pending ─→ picking ─→ packed ─→ label_created ─→ shipped ─→ in_transit ─→ delivered
```

- **Forward only, skips allowed.** A small store that packs without picking goes straight from `pending` to
  `packed`; a shipment that already shipped refuses both moves. Backwards is never allowed — `applyTransition`
  writes what it is told, so the legality check belongs to the caller and this module makes it.
- **An operator's illegal move is a 409**, unlike a carrier's out-of-order scan, which the tracking receiver
  records and skips. A person pressing the wrong button deserves to hear about it.
- **`parcel_count`** is optional on pack and must be a positive integer.
- `listPickLists` is the floor's queue: open shipments (`pending`, `picking`, `packed`) grouped by warehouse,
  oldest first, filterable by warehouse and status, paged over shipments rather than groups.

### The three events, and why they are not in the outbox yet

`fulfillment.requested`, `fulfillment.picking` and `fulfillment.packed` are part of #225 (events 0.3.0) and do
**not** exist in `@platform/events` yet. `withEvents` validates against the topics compiled into that package, so
emitting one today would fail validation — and `buildEvent`'s topic argument would not even typecheck.

`lifecycle-events.ts` is therefore the seam: the payloads are built and handed to an emitter that checks
`EVENT_TOPICS` at call time.

| Topic known to `@platform/events`? | What happens                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| yes (once 0.3.0 lands)             | straight to the outbox through `withEvents`, in the caller's transaction (ADR 0003) |
| not yet                            | buffered in memory, one warning per process; the state change still commits         |

Nothing changes on the day 0.3.0 lands: the same call starts writing to the outbox and the buffer stays empty.
`pendingLifecycleEvents()` is a test seam, not a queue — a process restart drops it, which is why the events are
worth nothing until the contract is real.

## HTTP (task 2.5)

`fulfillmentAdminRouter()` serves the three operations; mount it with one line in `src/http/module-routers.ts`
(REQUEST #176). Permissions come from a spec, never hard-coded: the real `admin-api.yaml` first, and while #225 is
open, `proposed/admin-api.pick-pack.yaml` — the same operations, filed verbatim. When Admin API 0.4.3 lands, the
fallback and the proposed file are deleted and nothing else changes.

| Route                                     | Notes                                                          |
| ----------------------------------------- | -------------------------------------------------------------- |
| `POST /admin/shipments/{shipmentId}/pick` | 200 `Shipment`; 409 when the move is illegal                   |
| `POST /admin/shipments/{shipmentId}/pack` | optional `parcel_count`; 400 when it is not a positive integer |
| `GET /admin/stores/{storeId}/pick-lists`  | `warehouse_id`, `status`, `page`, `limit`; 400 on a bad query  |

The two shipment paths name no store, so the shipment's store is resolved through an organization-scoped client
and a store-scoped client is used for the work. A shipment in **another organization** is a 404 — the same answer
as an id that does not exist, so guessing ids reveals nothing (tested).

## Next

Phase 2 is complete for this module. When events 0.3.0 and Admin API 0.4.3 land (#225), delete
`proposed/0160_shipment_pick_pack.sql`, `proposed/admin-api.pick-pack.yaml`, the test-side DDL and the
`permissionFor` fallback — the code behind them already works.
