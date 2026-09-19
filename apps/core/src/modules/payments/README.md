# payments — Stripe provider, capture, credentials, webhooks (window 7, tasks 2.1 #124 and 2.2 #125)

The `stripe` implementation of the checkout module's `PaymentProvider` seam (hosted fields / Payment Element:
card data NEVER touches this process, ADR 0004), the capture-on-confirm use case, and the per-store credential
loader, and (2.2) the signed Stripe webhook receiver with exactly-once processing and replay. Test mode only in
Phase 2 (decisions.md #10): live-mode keys are refused. Contracts: contracts-v0.4.1 (v0.3 at 2.1).

## Public API (`index.ts`)

| Export                                             | Purpose                                                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `registerPaymentProviders()`                       | registers `stripe` with the checkout registry; src/server.ts calls it at boot (REQUEST #176)                                                |
| `createStripePaymentProvider(opts?)`               | the `PaymentProvider`; `opts.apiFactory` / `opts.env` are test seams                                                                        |
| `capturePayment(client, paymentId, { actor })`     | capture on confirm; see below                                                                                                               |
| `stripeCredentialsFor(storeCode, env?)`            | per-store credentials, fail-closed; see below                                                                                               |
| `StripeClient` / `StripeError` / `StripeApi`       | thin fetch-based REST client (no `stripe` npm dependency — apps/core/package.json is window 1's; same precedent as search's Algolia client) |
| `FakeStripe`                                       | in-memory `StripeApi` for tests: idempotency map, call log, scriptable declines                                                             |
| `confirmIdempotencyKey(placementKey)`              | `confirm_<sha256(placement Idempotency-Key)>` — exported for tests                                                                          |
| `voidIdempotencyKey(voidKey)`                      | `void_<sha256(orders' `<payment.idempotency_key>:void`)>` — exported for tests                                                              |
| `paymentsWebhookRouter()`                          | `POST /webhooks/stripe/:storeCode` (2.2); mounted by src/server.ts outside `/store` and `/admin` (REQUEST #176 part 3)                      |
| `handleStripeWebhook(input)`                       | the receiver behind the router (signature → extract → exactly-once → process); see below                                                    |
| `replayWebhookEvent(client, evt_id)`               | reprocess a stored event idempotently; refuses a tampered extract (seal ≠ `payload_hash`)                                                   |
| `getWebhookEvent(client, evt_id)`                  | one stored event (runbook / tests)                                                                                                          |
| `verifyStripeSignature` / `signStripePayload`      | Stripe-Signature verification (constant time, raw body, secret-roll aware) and the header builder tests use                                 |
| `redactStripeEvent` / `sealExtract` / `verifySeal` | the redacted extract of an event and its integrity seal                                                                                     |
| `stripeWebhookSecretFor(storeCode, env?)`          | `STRIPE_WEBHOOK_SECRET_<CODE>`, else `STRIPE_WEBHOOK_SECRET`, else null (receiver fails closed)                                             |

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
  `void` resolves the store (and so the credentials) from the `payment` row by `provider_payment_id`; the
  checkout inserts that row before any step that can throw, and core 2.6 (#213) closed the remaining gap
  between `authorize` and the insert, so every hold a placement takes can be released.
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

## Webhooks — `POST /webhooks/stripe/:storeCode` (task 2.2, #125)

One Stripe endpoint per store (`https://<core>/webhooks/stripe/brand-a`), signed with that store's secret.
`webhook-router.ts` parses the RAW body (`express.raw`, 512 kB cap) and hands it to `handleStripeWebhook`:

1. **Signature first, before any parsing or database work.** `Stripe-Signature: t=…,v1=…[,v1=…]` → HMAC-SHA256
   of `"<t>.<raw body>"` with `STRIPE_WEBHOOK_SECRET_<CODE>` (else `STRIPE_WEBHOOK_SECRET`; none → 400 naming the
   variables). Timestamp within ±300 s, constant-time compare against EVERY `v1` entry (Stripe signs with both
   secrets during a roll). Rejection → 400 `validation_error` `{ reason }`, nothing written, nothing logged.
2. **Redacted extract + seal.** `redactStripeEvent` keeps ids, amounts, statuses, `last_payment_error.code /
decline_code` and our three metadata ids — never billing details, receipt email, shipping, description or
   foreign metadata. `payload_hash = sha256(raw body)`; the extract is sealed with
   `seal = sha256("<payload_hash>.<canonical extract>")` so an extract edited in the database (or a swapped
   hash) is detectable.
3. **Exactly once.** `INSERT … ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING id` (#187). A
   redelivery of a finished event answers 200 `{ duplicate: true, status }` and moves nothing. A redelivery of an
   event whose row is still `received` (its first delivery is between its commit and its order follow-ups, or it
   crashed there) **waits at the unique index while the first transaction is open**, then gets 409 `conflict` —
   unless the row is older than `IN_FLIGHT_TAKEOVER_SECONDS` (60 s), in which case the redelivery takes it over
   and finishes it. Never a silent 200 for work that is not done.
4. **Processing in the same transaction as the insert**: the payment row (`FOR UPDATE`) and the payment events
   through the outbox commit together with the `webhook_event` row. Order transitions (`markPaymentCaptured`,
   `markPaymentFailed`, `cancelOrder` — the orders module's idempotent wrappers) run after that commit in their own
   transactions, then the row gets its final status. A database failure rolls the whole delivery back → 5xx →
   Stripe retries; the idempotency of every step makes the retry safe.
5. **Out-of-order convergence is by state guard, never by `occurred_at`.** Each handler reads the payment row's
   CURRENT status and decides: already there / an earlier-state event after a later one → `skipped` with the
   reason; a claim that contradicts a terminal state of ours (Stripe says captured, our row says cancelled) →
   `failed` with `state_conflict: …` and nothing moves — a money discrepancy for a human. `occurred_at` is stored
   for audit only (carriers omit or backdate it; window 8's requirement on #187).

| Event                                      | Row `authorized`                                                                                               | Row `captured`               | Row `cancelled` / `failed`   | No row                                |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------- | ------------------------------------- |
| `payment_intent.succeeded`                 | → `captured` + `payment.captured` (fee null) → `markPaymentCaptured`; amount ≠ ours → `failed amount_conflict` | `skipped` (+ converge order) | `failed state_conflict`      | `failed` (captured without an order)  |
| `payment_intent.canceled`                  | → `cancelOrder` (voids via provider — already cancelled at Stripe → no-op; marks the row; `order.cancelled`)   | `failed state_conflict`      | `skipped`                    | `skipped`                             |
| `payment_intent.payment_failed`            | → `failed` + `payment.failed` → `markPaymentFailed`                                                            | `failed state_conflict`      | `skipped` / `state_conflict` | `skipped` (placement never completed) |
| `payment_intent.amount_capturable_updated` | `skipped` (rows are inserted authorized)                                                                       | `skipped`                    | `skipped`                    | `skipped`                             |
| `charge.refund*`, `refund.*`               | `skipped` — stored for task 2.3; replay after it lands                                                         | same                         | same                         | same                                  |
| anything else                              | `skipped unhandled_type` (stored, replayable)                                                                  | same                         | same                         | same                                  |

`webhook_event.status`: `received` (in flight) → `processed` | `skipped` | `failed` (+ `failure_reason`);
`replay_count` counts CLI replays; `aggregate_type/id` point at our payment row once resolved.

### Runbook

- **Register the endpoint** (test mode): Stripe Dashboard → Developers → Webhooks → add
  `https://<core>/webhooks/stripe/<store_code>`, events `payment_intent.*` (and `charge.refunded`, `refund.*` for
  2.3). Put the signing secret in `STRIPE_WEBHOOK_SECRET_<CODE>` (deployed: the store's
  `<env>/stores/<store_code>/stripe` secret, ADR 0006; locally `.env`). Local development: `stripe listen
--forward-to localhost:9000/webhooks/stripe/brand-a` prints a `whsec_…` to use the same way.
- **Rotate the secret**: Dashboard → the endpoint → "Roll secret" (choose an overlap up to 24 h; Stripe signs with
  both during it), set the new value in the env/secret store; the receiver reads it per delivery, no restart. The
  old value stops verifying when the overlap ends. Never paste a secret into a ticket or a log.
- **Replay**: `pnpm --filter @platform/core exec tsx src/modules/payments/replay-webhook.ts evt_…` — reprocesses
  the stored extract with the same guards (idempotent; a processed event moves nothing and emits nothing),
  bumps `replay_count`. Exit 0 processed/skipped, 2 refused (the extract no longer matches `payload_hash` —
  someone edited the row; re-deliver from the Stripe dashboard instead) or failed after reprocessing (reason
  printed), 1 otherwise. Use it to finish a `failed` event after its cause is fixed, an abandoned `received`
  one, or the `skipped unhandled_type` rows once a later task adds their handler.
- **Reading the table**: `SELECT provider_event_id, event_type, status, failure_reason, received_at FROM
webhook_event WHERE status IN ('received','failed') ORDER BY received_at` (the partial index serves it).
- **Nothing here logs a payload**: one line per delivery with the event id, type and outcome.

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
- **2026-09-15 · Webhook extract is sealed, not the raw body stored**: `payload_hash` stays sha256 of the raw
  body (#187's column meaning, shared with window 8); the extract carries `seal = sha256(payload_hash + "." +
canonical extract)`, so "payload no longer matches payload_hash" is checkable without ever storing the body.
- **2026-09-15 · In-flight duplicates: wait at the unique index, then 409; takeover after 60 s**. The insert is in
  the processing transaction, so a concurrent redelivery blocks on `(provider, provider_event_id)` until the
  first commits or rolls back; a row left `received` by a crash is finished by the next redelivery (or the CLI).
- **2026-09-15 · Conflicts are `failed`, replays are `skipped`**: a webhook that contradicts a terminal state of
  ours is a money discrepancy and stays visible in the failed listing; a harmless late/duplicate event is
  `skipped` with its reason. `payment_intent.canceled` goes through `cancelOrder` (the orders module owns the
  cancel and voids through the provider — a no-op on an already-cancelled intent), so a shipped order refuses
  it with 409 and the event lands as `failed` for a human.
- **2026-09-09 · A captured payment is never "voided"**: `void` reports `failed` when Stripe says the intent
  already succeeded, rather than a silent no-op success — a no-op would let `cancelOrder` cancel an order the
  customer was charged for. Already-`canceled` stays a no-op success (idempotent retry).
- **2026-09-08 · Events split with window 1**: placement's `payment.authorized` is emitted by the checkout
  module right after it inserts the `payment` row (REQUEST #176 — only that code shares the row's transaction);
  this module emits `payment.captured` / `payment.failed` (capture) and `refund.*` (2.3) in its own transactions.

## Tests

`webhooks.test.ts` (18; FakeStripe + seeded throwaway database — `webhook_event` comes from migration 0140 in
@platform/db): signature parse/verify/roll/tolerance/tamper; extract redaction + seal
(tamper either side, key-order independence); gate (bad signature → 400 nothing written, store secret beats the
global one, missing secret names the variables, bad JSON / non-event, another store's client → 404);
`payment_intent.succeeded` end to end (row + `payment.captured` + order `captured`, row redacted, hash + seal
verified, log lines carry no PII); duplicate → no second transition; in-flight duplicate → 409, abandoned →
takeover; out-of-order (authorization after capture skipped; succeeded after canceled → `state_conflict`, row
stays cancelled); `payment_failed` (row + event + order); amount conflict and foreign intent → `failed` rows;
unhandled types skipped; replay (idempotent, `replay_count`, tampered extract refused, unknown → 404, finishing a
failed event); the router through supertest (200 processed / 200 duplicate / 400 / 404).

`payments.test.ts` (FakeStripe + seeded throwaway database): credential precedence / fail-closed / live-key
refusal / no-restart rotation; client form-encoding, headers, idempotency header, error mapping (no body echo);
session create + reuse + replace, metadata ids-only; authorize confirm path + idempotent replay (one confirm,
no second intent), declines, amount mismatch, outage rethrow; full `completeCart` with `stripe` registered
(payment row `stripe` / `pi_…`); capture happy path (row + fee + `payment.captured` + order `captured` +
`order.updated`), replay no-op, converging replay after a simulated crash, definitive failure (row `failed` +
`payment.failed` + order `failed` + 402), outage leaves everything untouched; refund mapping; PII scan of every
fake call. `stripe-live.test.ts`: real test-mode intent → confirm (`pm_card_visa`) → capture → refund; skips
without `STRIPE_SECRET_KEY`.
