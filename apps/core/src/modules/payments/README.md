# payments — Stripe provider, capture, credentials (window 7, task 2.1, issue #124)

The `stripe` implementation of the checkout module's `PaymentProvider` seam (hosted fields / Payment Element:
card data NEVER touches this process, ADR 0004), the capture-on-confirm use case, and the per-store credential
loader. Test mode only in Phase 2 (decisions.md #10): live-mode keys are refused. Contracts: contracts-v0.3.

## Public API (`index.ts`)

| Export                                         | Purpose                                                                                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `registerPaymentProviders()`                   | registers `stripe` with the checkout registry; src/server.ts calls it at boot (REQUEST #176)                                                |
| `createStripePaymentProvider(opts?)`           | the `PaymentProvider`; `opts.apiFactory` / `opts.env` are test seams                                                                        |
| `capturePayment(client, paymentId, { actor })` | capture on confirm; see below                                                                                                               |
| `stripeCredentialsFor(storeCode, env?)`        | per-store credentials, fail-closed; see below                                                                                               |
| `StripeClient` / `StripeError` / `StripeApi`   | thin fetch-based REST client (no `stripe` npm dependency — apps/core/package.json is window 1's; same precedent as search's Algolia client) |
| `FakeStripe`                                   | in-memory `StripeApi` for tests: idempotency map, call log, scriptable declines                                                             |
| `confirmIdempotencyKey(placementKey)`          | `confirm_<sha256(placement Idempotency-Key)>` — exported for tests                                                                          |
| `voidIdempotencyKey(voidKey)`                  | `void_<sha256(orders' `<payment.idempotency_key>:void`)>` — exported for tests                                                              |

## The provider

- **`createSession`** (`POST /store/carts/{cartId}/payment-session` with `provider: stripe`): creates a
  manual-capture PaymentIntent for the cart's current total (`automatic_payment_methods` with redirects off;
  metadata carries `cart_id` / `store_id` / `organization_id` — ids only, never an email or address). If the cart
  already holds a stripe session, the SAME intent is updated to the new amount so the storefront's mounted
  Payment Element stays valid; an intent that can no longer be updated is reused when it already matches the
  total, otherwise cancelled (best effort) and replaced. The storefront renders hosted fields with
  `client_secret`.
- **`authorize`** (inside window 1's placement transaction): retrieves the intent and checks its amount and
  currency against the cart BEFORE anything else — a mismatch fails without confirming, so no authorization
  hold is ever placed for a total the order does not have (mismatch → `failed`: "create a new payment
  session"). Then it confirms server-side only when the intent is `requires_confirmation`, with Stripe
  idempotency key `confirmIdempotencyKey(placement key)` — a retried placement can never create a second
  authorization — and `requires_capture` / `succeeded` counts as authorized.
  Declines map to `failed` with `decline_code` (else `code`) as the reason →
  402 upstream, nothing written. Stripe outages (5xx / 429 / network) are RETHROWN so the placement aborts as
  retryable instead of telling the shopper their card failed. `requires_action` and `processing` map to `failed`
  in Phase 2 (redirect-less card flows; documented trade-off, revisit with async payment methods).
- **`void`** (orders module 2.3: `cancelOrder`, and the placement failure path): cancels the PaymentIntent so
  the authorisation hold is released, idempotency key `void_<sha256(<payment.idempotency_key>:void)>` — the key
  the orders module passes — so a retried cancel replays Stripe's recorded response. An intent Stripe refuses to
  cancel (`payment_intent_unexpected_state`) is retrieved and judged on its real state: `canceled` → `voided`
  (the hold is already gone, and a retry must not become a 402); `succeeded` → `failed` naming the capture,
  because captured money comes back only through a refund — window 1's own `cancelOrder` says the same ("a
  captured payment is window 7's to refund"), so the cancel is refused loudly instead of cancelling a charged
  order. Outages rethrow, leaving the hold in place for the retry.
- **`refund`** (task 2.3's entry point): `POST /v1/refunds` on the intent with idempotency key
  `refund_<refund Idempotency-Key>`. Stripe `pending` counts as succeeded (funds are on their way; the 2.2
  webhook receiver picks up a later `refund.failed`). The store — and so the credentials — is resolved from the
  `payment` row by `provider_payment_id` (RLS-scoped, so a tenant client can only refund its own payments).

## Capture on confirm — `capturePayment(client, paymentId, { actor })`

One transaction on the scoped client: `payment` row locked `FOR UPDATE` → must be `stripe` (400) and
`authorized` (409 `{ field, from, to }` otherwise; `captured` → replay, see below) → Stripe capture with
idempotency key `capture_<payment_id>` and `latest_charge.balance_transaction` expanded → row `captured` with
`captured_at` and `fee_minor` (null when Stripe does not return the balance transaction) → `payment.captured`
v1 through `withEvents`, same transaction. Then, in its own transaction, the orders module's
`markPaymentCaptured` (idempotent on the target state; emits its `order.updated`).

- A **definitive** Stripe failure (4xx, not 429) writes row `failed` + `failure_reason` + `payment.failed` in
  the same transaction, then `markPaymentFailed`, then throws 402 `payment_failed`. An outage writes NOTHING
  and rethrows: retry later, the idempotency key makes the retry safe.
- **Replay**: a `captured` row makes no Stripe call and emits nothing new, but still calls
  `markPaymentCaptured` — so a crash between the payment transaction and the order transition is healed by
  calling `capturePayment` again. Returns `{ payment, replayed: true }`.
- `./orders-seam.ts` re-exports `markPaymentCaptured` / `markPaymentFailed` from `../orders` (window 1's orders
  module, #174, on main since merge round 8). It stays as the module's single import point for the orders seam,
  so the webhook receiver (2.2) and any later caller share one place where that boundary is documented.

## Credentials (ADR 0006)

`stripeCredentialsFor(storeCode)` reads, in order: `STRIPE_SECRET_KEY_<CODE>` (per store; `brand-a` →
`_BRAND_A`), else `STRIPE_SECRET_KEY`. Webhook secret the same way (`STRIPE_WEBHOOK_SECRET[_<CODE>]`, used by
task 2.2). Deployed, these env variables are Vault/Secrets-Manager-injected from `<env>/stores/<store_code>/stripe`
(the chart's `externalSecrets.remoteKeys`); locally they come from the repo-root `.env` (rows exist in
`.env.example` since b9baf84). Behaviour:

- **Fail closed at first use**: no key → an error naming the VARIABLES (never a value) → 400 on
  `createPaymentSession`. A store without keys keeps using the `manual` provider; nothing breaks at boot.
- **Test mode only**: `sk_live_` / `rk_live_` keys are refused outright in Phase 2.
- Values are read from the environment on every call (no cache), so rotation needs no restart. Nothing in this
  module logs a credential, an email, or a payload — ids, amounts and status codes only.

## Setup and test cards

```bash
# repo-root .env (test mode only)
STRIPE_SECRET_KEY=sk_test_…          # per-store override: STRIPE_SECRET_KEY_BRAND_A=…
STRIPE_WEBHOOK_SECRET=whsec_…        # task 2.2
STRIPE_PUBLISHABLE_KEY=pk_test_…     # storefront's Payment Element (window 3)
```

Stripe test payment methods (never raw card numbers server-side): `pm_card_visa` (authorizes),
`pm_card_chargeDeclined` (declines), `pm_card_chargeDeclinedInsufficientFunds`. The live integration test
(`stripe-live.test.ts`) skips itself without `STRIPE_SECRET_KEY`; with a key it creates, confirms, captures and
refunds a real test-mode PaymentIntent.

## Decisions (ADR-style)

- **2026-09-08 · Fetch-based client, no `stripe` npm package**: the dependency would need window 1's
  package.json; the REST surface we use is small; the client is injectable so tests run on `FakeStripe`
  (accepted by the manager with the 2.1 plan).
- **2026-09-08 · Manual capture**: authorize at placement, capture at confirm (order flow owns the timing);
  `capture_method: 'manual'` on every intent.
- **2026-09-08 · Session reuse over re-create**: `createSession` on a cart with a stripe session updates the
  existing intent so the storefront's Payment Element keeps working across total changes.
- **2026-09-08 · Outage ≠ decline**: only definitive Stripe rejections mark a payment `failed`; 5xx/429/network
  rethrow so nothing is written and the action is retried.
- **2026-09-09 · A captured payment is never "voided"**: `void` reports `failed` when Stripe says the intent
  already succeeded, rather than a silent no-op success — a no-op would let `cancelOrder` cancel an order the
  customer was charged for. Already-`canceled` stays a no-op success (idempotent retry).
- **2026-09-08 · Events split with window 1**: placement's `payment.authorized` is emitted by the checkout
  module right after it inserts the `payment` row (REQUEST #176 — only that code shares the row's transaction);
  this module emits `payment.captured` / `payment.failed` (capture) and `refund.*` (2.3) in its own transactions.

## Tests

`payments.test.ts` (FakeStripe + seeded throwaway database): credential precedence / fail-closed / live-key
refusal / no-restart rotation; client form-encoding, headers, idempotency header, error mapping (no body echo);
session create + reuse + replace, metadata ids-only; authorize confirm path + idempotent replay (one confirm,
no second intent), declines, amount mismatch, outage rethrow; full `completeCart` with `stripe` registered
(payment row `stripe` / `pi_…`); capture happy path (row + fee + `payment.captured` + order `captured` +
`order.updated`), replay no-op, converging replay after a simulated crash, definitive failure (row `failed` +
`payment.failed` + order `failed` + 402), outage leaves everything untouched; refund mapping; PII scan of every
fake call. `stripe-live.test.ts`: real test-mode intent → confirm (`pm_card_visa`) → capture → refund; skips
without `STRIPE_SECRET_KEY`.
