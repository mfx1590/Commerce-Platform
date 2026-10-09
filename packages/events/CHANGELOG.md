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
