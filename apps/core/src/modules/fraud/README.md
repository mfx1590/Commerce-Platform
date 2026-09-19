# fraud — check before authorization, review flag, Radar webhooks (window 7, task 2.5, issue #128)

A fraud check that runs BEFORE authorization and answers `allow` / `review` / `block` with a reason CODE, two
providers behind a `FraudProvider` interface (local rules, Stripe Radar), a review flag that holds an order,
and Radar's review webhooks. It looks at FACTS — ids, amounts, countries, the checkout's `email_hash` — never
at an email, a name, an address or a card. Test mode only in Phase 2. Contracts: contracts-v0.4.2 (nothing in
packages/\* changes).

## Public API (`index.ts`)

| Export                                                                             | Purpose                                                                                                                               |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `registerFraudCheck(opts?)`                                                        | boot mount point (REQUEST #231): registers the check with the seam and Radar's `review.*` handlers with the payments webhook receiver |
| `createFraudCheck(opts?)`                                                          | the check: providers in order, worst outcome wins, outage → `review`, block recorded in `audit_log`                                   |
| `rulesFraudProvider` / `createRadarFraudProvider(opts?)`                           | the two `FraudProvider`s                                                                                                              |
| `fraudSettingsFrom(store.settings)` / `DEFAULT_FRAUD_SETTINGS`                     | the store setting reader (never throws)                                                                                               |
| `setFraudCheck` / `currentFraudCheck` / `enforceDecision` / `applyDecisionToOrder` | LOCAL STAND-IN for the checkout seam requested in #231                                                                                |
| `flagOrderForReview` / `resolveOrderReview` / `readOrderFraud`                     | the review flag of an order, kept on its PAYMENT row until the orders module gets its own function (#231)                             |
| `fraudMetrics`                                                                     | in-process counters: evaluations by outcome, decisions by reason code, outages by provider                                            |
| `RADAR_WEBHOOK_HANDLERS`                                                           | `review.opened` / `review.closed`                                                                                                     |

## The three decisions that shape this module

1. **A provider outage is `review` — never block, never a silent pass** (manager decision 2026-09-19). Fraud
   scoring is advisory risk: an outage that stopped all checkout would be a self-inflicted incident, one that
   waved everything through an open door. The order is placed and held for a human, with reason
   `provider_unavailable`, and the outage is made VISIBLE: one log line (store id, provider, error class — no
   payload) and `fraud_provider_outages_total{provider}`. A missing Stripe key counts as a provider problem too.
   (Tax fails closed instead because a wrong tax is a money error; this is not.)
2. **A `block` answers exactly like a decline**: 402 `payment_failed`, the generic message, `details.provider`
   only — no fraud-specific code or wording on the Store API, ever. A distinct answer would tell a probing
   fraudster which attempt tripped a rule. The real reason is recorded internally: an `audit_log` row
   (`fraud.block`, entity = the cart, `after` = outcome, reason code, provider, amount, currency, payment
   provider — no PII) written in its OWN transaction, because the placement transaction rolls back on a block
   and the record must survive it. Writing the record is best effort; the decision stands either way.
3. **Rules never block.** A local heuristic holds an order for a human; only Radar's `highest` risk level blocks
   (and a store can turn even that into `review`).

## Store settings — `store.settings.fraud`

```jsonc
{
  "fraud": {
    "providers": ["rules", "radar"],
    "velocity": { "max_orders": 3, "window_minutes": 60 },
    "country_mismatch": "review", // or "allow"
    "radar_highest": "block", // or "review"
  },
}
```

Unknown or malformed values fall back to these defaults; reading settings never throws.

## Providers

- **`rules`** — _velocity per email hash_: the store already has `max_orders` or more non-cancelled orders for
  this hash within `window_minutes` → `review` (`velocity_email`). The comparison runs in SQL on
  `sha256(lower(btrim(email)))` — the same function as the checkout's `emailHash` — so the email is never
  selected, returned or logged, and the query runs on the placement transaction, so RLS keeps another brand's
  orders out. _Mismatched countries_: shipping ≠ billing country → `review` (`country_mismatch`).
- **`radar`** — with the Payment Element the intent is confirmed client-side before placement, so its latest
  charge already carries Radar's `outcome`: `risk_level: highest` → `block` (`radar_highest`), `type:
manual_review` → `review`, `risk_level: elevated` → `review`. One `retrievePaymentIntent` with
  `expand[]=latest_charge` through the payments client and the store's own key. Non-stripe payments and intents
  without a charge yet are `allow` here; Radar still acts at confirmation and the webhooks below catch it.

Reason codes are a closed set (`FRAUD_REASON_CODES`): they end up in order metadata, the audit log and events,
so free text — and with it PII — has no way in.

## What `review` does to an order

Only the orders module may update the `"order"` row (window 1's structural guard), and it has no function for
flagging an order yet (#231). So this module does not touch the order row: the flag is written on the order's
**payment** row — `payment.metadata.fraud = { status: 'review', reason_code, provider, flagged_at }`, the payments
side's own aggregate and the thing a review actually holds — plus ONE `order.updated` through the orders module's
public `transition()`, same transaction. `order.updated` v1 has no reason field and forbids extra properties, so
the code travels in `changed_fields`: `["fraud", "fraud.reason_code=<code>", "fraud.status=review"]`. The order
stays `pending`, and **`capturePayment` refuses a payment whose fraud status is `review` or `confirmed_fraud`**
(409 with the reason code): the authorization hold stays on the card until a human clears the review
(`resolveOrderReview(…, { status: 'cleared' })` → capturable) or cancels the order (which voids the hold).
Flagging and resolving are idempotent on the target status. When #231 lands, `order.metadata.fraud` becomes a
mirror written by the orders module's own function.

## Radar review webhooks

Registered with the payments receiver (`registerWebhookHandler`), so they inherit its signature check, redacted
extract, exactly-once, replay and state guards. `review.opened` → flag (`radar_review_opened`);
`review.closed` with `closed_reason: approved` → `cleared`, anything else (`refunded`, `refunded_as_fraud`,
`disputed`, `redacted`) → `confirmed_fraud`. A `closed` delivered before its `opened` records the review first;
a late `opened` after a `closed` never re-opens it; unknown intents are `skipped`. Without this module registered
the receiver stores `review.*` as `skipped unhandled_type` — replayable later.

## What is window 1's (REQUEST #231)

The checkout has no fraud hook and the orders module has no function to flag an order. #231 asks for
`setFraudCheck` in the checkout (evaluated inside the placement transaction before `authorize`; `block` → the
plain 402; `review` → flag after the order insert), `flagOrderForReview` / `resolveOrderReview` in the orders
module, the boot mount line, and the three CLAUDE.md rows. Until it lands `seam.ts` and `order-flag.ts` are the
stand-ins (same role as `payments/orders-seam.ts` in 2.1), and `fraud.test.ts` plays the checkout's part.

## Tests

`fraud.test.ts` (14; seeded throwaway database + FakeStripe): settings reader and ranking; the shared credential
loader (precedence, rotation, fail-closed error naming variables and path, never a value); velocity (threshold,
email spelling, store boundary, window, no email), country mismatch (+ setting); Radar mapping and
non-stripe payments; worst outcome wins + counters; outage → review with a log line and a metric (incl. a
vanished key, and an earlier review reason surviving a later outage); block = plain decline body with the real
reason in `audit_log` after the rollback; review holds the order (pending, flag, `order.updated` with the code
and no PII, idempotent flag, capture refused, cleared → captured); `review.opened` / `closed` (duplicate, late,
out of order, confirmed fraud uncapturable, unknown intent, unregistered module).
