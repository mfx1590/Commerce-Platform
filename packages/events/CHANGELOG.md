# Changelog — @platform/events

## 0.1.0 — 2026-09-04

- Scaffold created by the main window (Phase 0).

## 0.1.0 — 2026-09-04 (Phase 0 step 5)

- 24 event schemas v1 (JSON Schema 2020-12) + common $defs + envelope; `additionalProperties: false` everywhere; no PII fields.
- `scripts/generate.mjs` → `src/generated/{schemas,types}.ts` (json-schema-to-typescript); committed.
- `createValidator`, `makeEvent`, `toOutboxRow`; `migrations/0100_outbox.sql` (outbox table + RLS, applied by packages/db).

## 0.2.0 — 2026-09-08 (Integration 1, marketing)

- Seven new v1 topics (31 total): `campaign.launched`, `campaign.ended`, `feed.published`, `attribution.recorded`, `referral.converted`, `review.published`, `cart.abandoned` (docs/marketing-scope.md). Payloads carry ids, enums, minor amounts and hashes only: no review text, `code_hash` instead of the referral code, `email_hash` instead of the email, `referrer` is an origin.
- Decided at Integration 1: attribution is its own event (`attribution.recorded`, one per touch, same transaction as `order.placed`); `order.placed` stays at v1.
- Envelope v1: `topic` and `aggregate_type` enums extended (additive) with the new topics and `campaign`, `feed`, `attribution`, `referral`, `review`, `cart`. Existing envelopes keep validating; an envelope v2 would have forced every consumer to migrate for an enum widening.

## 0.3.0 — 2026-09-19 (CONTRACT CHANGE #225, fulfillment lifecycle; contracts-v0.4.3)

- Three additive v1 schemas: `fulfillment.requested` (a warehouse or 3PL accepted the fulfilment; carries provider + external_id), `fulfillment.picking` (picking started), `fulfillment.packed` (ready for the carrier; optional parcel_count). All carry ids, quantities and a timestamp only — no address, no name, no email. Envelope topic enum gains the three topics (34 total, was 31).
- Producer: window 8 (fulfillment module, task 2.5). Consumers: windows 4 (admin fulfillment screens), 11 (warehouse, Phase 3), 15 (accounting reads shipment.shipped as before — fulfillment.* are workflow signals, not money).

## 0.3.1 — 2026-10-06 (CONTRACT CHANGE #354, Integration 2a; contracts-v0.4.11)

- One additive v1 schema: `shipment.label_created` — a carrier label was bought for a packed shipment (`buyShipmentLabel`, Admin API 0.4.9). Payload: `shipment_id`, `order_id`, `store_id`, `carrier`, `tracking_number`, `label_url`, `created_at`; ids, the tracking number and the label URL only — no address, no name. Envelope topic enum gains it (35 topics, was 34). `payment.captured`, `order.confirmed` and `order.completed` already exist at v1 and are unchanged.
- Producer: the core's shipping module (in the same transaction as the move to `label_created`). Consumers: admin fulfillment screens; nobody is required to handle it (unknown-topic rule).

## 0.3.2 — 2026-10-08 (CONTRACT CHANGE #425, for core 3.2 #414; contracts-v0.4.14)

- One additive v1 schema: `customer.export_requested` — a GDPR data export was requested for one customer of one store
  (Admin API `exportCustomer`, 202). Payload is ids only: `customer_id`, `requested_by` (staff_user id), `requested_at`;
  `additionalProperties: false`, so no personal data can ever ride on it.
- Producer: the core's customers module, one row per request in the same transaction as the 202 (no dedupe — every request
  is a new request). Consumer: the GDPR export delivery (Integration 2b: storage + email); nobody is required to handle it
  (unknown-topic rule). 36 topics in v1.

## 0.3.3 — 2026-10-12 (CONTRACT CHANGE #453, stock pool step 2; contracts-v0.4.15)

- `stock.moved` **v2** (the first second version of a topic): stock is held per stock item and warehouse (db 0.3.5,
  migration 0191), so the payload requires `stock_item_id` and `sku` is the stock item's. `variant_id` and `store_id`
  are optional and come together (`dependentRequired`): present when a store caused the movement (a sale, a return, a
  shipment release), both absent for a pool movement no store caused (receipt, transfer, cycle count), whose envelope
  `store_id` is null. v1 is frozen and unchanged; `LATEST_VERSION['stock.moved']` is 2, so `makeEvent` writes v2.
- One additive v1 schema: `stock_item.mapped` — a store's variant was mapped to a stock item (Admin API
  `mapVariantToStockItem`, 0.4.13). Payload is ids only: `stock_item_id`, `previous_stock_item_id`, `variant_id`,
  `store_id`; `additionalProperties: false`. Envelope `store_id` is the variant's store, `aggregate_id` the item the
  variant is mapped to now.
- Envelope v1 (additive, as in 0.2.0): topic enum gains `stock_item.mapped` (37 topics, was 36), `aggregate_type` gains
  `stock_item`.
- Producer: the core's inventory module (window 1, #456), each in the same transaction as the state change. Consumers
  of `stock.moved` (search/availability, accounting, warehouse) must handle v2 from this release on and key by
  `stock_item_id`; `stock_item.mapped` is optional for everyone (unknown-topic rule).

## 0.3.4 — 2026-10-15 (CONTRACT CHANGE #466, Order.payment_status `voided`; contracts-v0.4.17)

- `order.updated` v1: the `payment_status` enum gains `voided` (authorized → voided when `cancelOrder` releases the
  authorization; terminal). Additive enum value in v1, widened in place and not a v2 (manager decision on #466): every
  producer and reader is inside apps/core; no consumer before Phase 4. If a consumer exists by the next such widening,
  that one is a v2. `order.cancelled` v1 is unchanged; 37 topics, unchanged.
- Producer: the core's orders module (window 1, a later PR): its own `order.updated` with
  `changed_fields: ['payment_status']`, in the same transaction as the void, before the status moves to `cancelled`.

## 0.3.5 — 2026-10-18 (CONTRACT CHANGE #482, customer self-service; contracts-v0.4.20)

- `customer.export_requested` v2: adds the required `requested_by_type` (`staff` | `customer`, closed enum);
  `requested_by` is the staff_user id or the customer id accordingly (the Store API `requestMyExport` has no staff
  id). Ids only, `additionalProperties: false`. v1 stays registered and frozen; `makeEvent` writes v2;
  `LATEST_VERSION['customer.export_requested']` is 2. 37 topics, unchanged.
- Producers: the core's customers module (window 13) — the admin `exportCustomer` path with
  `requested_by_type: staff`, `requestMyExport` with `customer`. No consumer yet (13.3 / #472 is the first and reads
  v2).

## 0.3.6 — 2026-10-18 (CONTRACT CHANGE #498, customer export delivery; contracts-v0.4.23)

- One additive v1 schema: `customer.export_ready` — a GDPR export bundle is built and downloadable (Store API
  `getMyExport`, Admin API `getCustomerExport`) until `expires_at`. Payload is ids and timestamps only:
  `export_id`, `customer_id`, `requested_by`, `requested_by_type` (`staff` | `customer`, closed enum), `expires_at`;
  `additionalProperties: false` — never the bundle, never personal data. `aggregate_type` `customer`,
  `aggregate_id` the customer id (as `customer.export_requested`). `LATEST_VERSION['customer.export_ready']` is 1.
- Envelope v1 (additive, as in 0.2.0): topic enum gains `customer.export_ready` next to
  `customer.export_requested` (38 topics, was 37).
- Producer: the core's customers module export job (window 13, #472), one event in the same transaction as the move
  to `ready` (none for `too_large` / `customer_gone`). Consumer: the notifications app (window 17) mails the
  customer, reading the address from the customer row at send time; nobody else is required to handle it
  (unknown-topic rule).
