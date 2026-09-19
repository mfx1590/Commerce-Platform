# fraud — check before authorization, review flag, Radar webhooks (window 7, task 2.5, issue #128)

A fraud check that runs BEFORE authorization and answers `allow` / `review` / `block` with a reason CODE, two
providers behind a `FraudProvider` interface (local rules, Stripe Radar), a review flag that holds an order,
and Radar's review webhooks. It looks at FACTS — ids, amounts, countries, the checkout's `email_hash` — never
at an email, a name, an address or a card. Test mode only in Phase 2. Contracts: contracts-v0.4.2 (nothing in
packages/\* changes).

## Public API (`index.ts`)

| Export                                                         | Purpose                                                                                                                                                                                                                                 |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `registerFraudCheck(opts?)`                                    | boot mount point (`registerModuleSeams()` in `src/wiring.ts`): registers the check with the CHECKOUT's seam — the registry `completeCart` reads — and Radar's `review.*` handlers with the payments webhook receiver; returns the check |
| `createFraudCheck(opts?)`                                      | the check (`ModuleFraudCheck`): providers in order, worst outcome wins, outage → `review`; `recordBlocked` / `flushBlockRecords` write the block record AFTER the placement rolled back                                                 |
| `rulesFraudProvider` / `createRadarFraudProvider(opts?)`       | the two `FraudProvider`s                                                                                                                                                                                                                |
| `fraudSettingsFrom(store.settings)` / `DEFAULT_FRAUD_SETTINGS` | the store setting reader (never throws)                                                                                                                                                                                                 |
| `setFraudCheck` / `currentFraudCheck`                          | the checkout's seam functions, re-exported (they ARE the checkout's: same registry, same object)                                                                                                                                        |
| `flagOrderForReview` / `resolveOrderReview` / `readOrderFraud` | the review flag: payment row (source of truth) + the order mirror through the orders module; a resolved review is never re-flagged                                                                                                      |
| `fraudMetrics`                                                 | in-process counters: evaluations by outcome, decisions by reason code, outages by provider                                                                                                                                              |
| `RADAR_WEBHOOK_HANDLERS`                                       | `review.opened` / `review.closed`                                                                                                                                                                                                       |

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
   provider — no PII). **That row is written AFTER the placement transaction has rolled back — never inside it,
   and never on a second connection while it is open** (manager decision 2026-09-19): `evaluate()` runs inside the
   placement transaction and writes NOTHING, it only remembers the blocked placement; `recordBlocked()` writes the
   row in its own transaction once the placement has unwound. (The first version wrote it from inside
   `evaluate()` on a second pool connection: a burst of blocks the size of the pool would have dead-locked it.)
   The checkout calls `recordBlocked` from its post-rollback catch once REQUEST #241 lands; until then
   `evaluate()` schedules a deferred flush that the placement never awaits (`deferredRecord: false` turns it
   off; `flushBlockRecords()` makes it deterministic). Writing the record is best effort; the decision stands.
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

**Source of truth = the order's PAYMENT row** — `payment.metadata.fraud = { status, reason_code, provider,
flagged_at, resolved_at?, resolution? }`, the payments side's own aggregate and the thing a review actually holds:
**`capturePayment` refuses a payment whose fraud status is `review` or `confirmed_fraud`** (409 with the reason
code), so the authorization hold stays on the card until a human clears the review (`resolveOrderReview(…,
{ status: 'cleared' })` → capturable) or cancels the order (which voids the hold). The order stays `pending`.

**The ORDER carries a mirror** (`order.metadata.fraud`), written ONLY by the orders module's own functions (only
that module may update the `"order"` row — its structural guard), which also emit the ONE `order.updated` of each
change. `order.updated` v1 has no reason field and forbids extra properties, so the code travels in
`changed_fields`: `["fraud", "fraud.reason_code=<code>", "fraud.status=review"]` (manager ruling: correct within
the frozen schema; a proper field waits for the Phase 4 events window).

Who writes what: a review decided AT placement is written by the checkout itself (payment row with the insert +
the mirror, core #236). Every LATER change goes through this module's two writers — the Radar `review.*` webhook
handlers included — and each writer does payment row first, then the orders module's mirror function, so a review
opened after placement has its order mirror like any other. A payment flagged before the mirror existed gets its
mirror first, then the resolution. Writers are idempotent on the target status, and **a review that was already
resolved (`cleared` / `confirmed_fraud`) is never re-opened by a later flag**: nothing is written, no event.

## Radar review webhooks

Registered with the payments receiver (`registerWebhookHandler`), so they inherit its signature check, redacted
extract, exactly-once, replay and state guards. `review.opened` → flag (`radar_review_opened`);
`review.closed` with `closed_reason: approved` → `cleared`, anything else (`refunded`, `refunded_as_fraud`,
`disputed`, `redacted`) → `confirmed_fraud`. A `closed` delivered before its `opened` records the review first;
a late `opened` after a `closed` never re-opens it; unknown intents are `skipped`. Without this module registered
the receiver stores `review.*` as `skipped unhandled_type` — replayable later.

## Window 1's side

REQUEST #231 landed with core #236: `setFraudCheck` in the checkout (`src/lib/fraud-seam.ts`; `completeCart`
evaluates inside the placement transaction before `authorize`, `block` → the plain 402, `review` → payment flag +
order mirror; a check that THROWS is a `review` there too), `flagOrderForReview` / `resolveOrderReview` in the
orders module, and the boot line in `src/wiring.ts`. This module now registers with that seam directly, so the
wiring's bridge line (`setFraudCheck(fraudModuleCheck())`) is a no-op. Open: REQUEST #241 — the checkout calls
`recordBlocked` after its rollback (see decision 2), and the bridge line can go.

## Tests

`fraud.test.ts` (16; seeded throwaway database + FakeStripe): settings reader and ranking; the shared credential
loader (precedence, rotation, fail-closed error naming variables and path, never a value); velocity (threshold,
email spelling, store boundary, window, no email), country mismatch (+ setting); Radar mapping and non-stripe
payments; worst outcome wins + counters; outage → review with a log line and a metric (incl. a vanished key, and an
earlier review reason surviving a later outage); **block through the real `completeCart`** (plain decline body,
nothing placed or authorized, NO audit row until the flush after the rollback, then exactly one);
**`evaluate()` writes nothing while the placement transaction is open**, `recordBlocked` afterwards, a failing
record is logged and changes nothing; **review through the real `completeCart`** (pending, payment flag, order
mirror, ONE `order.updated` with the code and no PII, idempotent flag, capture refused, cleared → mirror +
second event + captured, a resolved review is never re-flagged); the registration lands in the checkout's seam
(same object); `review.opened` / `closed` with the ORDER MIRROR for reviews opened after placement (duplicate,
late, out of order, confirmed fraud uncapturable, unknown intent, unregistered module).
