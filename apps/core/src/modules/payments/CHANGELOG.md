# Changelog — payments module (window 7)

The app-level `apps/core/CHANGELOG.md` and the module row in `apps/core/CLAUDE.md` belong to window 1; this
file is the module's own history (linked from the PRs).

## Phase 2 — payments/phase2 (contracts-v0.3 → v0.4.1)

### 2026-09-15 · 2.2 Signed webhook receiver with idempotency and replay protection (#125)

- `webhook-signature.ts`: `Stripe-Signature` parsing, HMAC-SHA256 over `"<t>.<raw body>"`, ±300 s tolerance,
  constant-time compare against every `v1` entry (secret roll), `signStripePayload` for tests/CLI parity.
- `webhook-extract.ts`: `redactStripeEvent` (ids, amounts, statuses, error codes, our metadata ids — no PII),
  `canonicalJson`, `sha256Hex`, `sealExtract` / `verifySeal` (extract bound to `payload_hash`).
- `webhook-receiver.ts`: `handleStripeWebhook` — signature before any parsing/DB work; insert-or-skip on
  `(provider, provider_event_id)` with processing in the same transaction; in-flight duplicate → wait then 409,
  takeover after 60 s; state-guarded handlers for `payment_intent.succeeded` / `canceled` / `payment_failed` /
  `amount_capturable_updated`, everything else stored as `skipped` (replayable); order transitions through the
  orders module (`markPaymentCaptured`, `markPaymentFailed`, `cancelOrder`); `replayWebhookEvent` (idempotent,
  refuses a tampered extract, counts replays); `getWebhookEvent`.
- `replay-webhook.ts`: the CLI (`tsx src/modules/payments/replay-webhook.ts evt_…`; exit 0/2/1).
- `webhook-router.ts`: `paymentsWebhookRouter()` — `POST /webhooks/stripe/:storeCode` on the raw body; mount line
  requested on #176 (part 3).
- `credentials.ts`: `stripeWebhookSecretFor` (the receiver verifies without needing the secret key).
- `proposed/0140_webhook_event.sql`: #187's DDL, applied by `webhooks.test.ts` only until migration 0140 lands.
- Tests: `webhooks.test.ts` (18). README: webhook section + runbook (register, rotate, replay, read the table).

### 2026-09-08 · 2.1 Stripe provider (hosted fields, test mode), capture on confirm, per-store credentials (#124)

- `credentials.ts`: `stripeCredentialsFor(storeCode, env)` — `STRIPE_SECRET_KEY_<CODE>` / `STRIPE_WEBHOOK_SECRET_<CODE>`
  win over the global pair (ADR 0006 `<env>/stores/<store_code>/stripe`); fail-closed error naming variables,
  never values; live-mode keys refused (Phase 2 test mode only); read per call → rotation without restart.
- `stripe-client.ts`: `StripeClient` over Node's global fetch (no `stripe` npm dependency), Stripe form
  encoding, `Idempotency-Key`, pinned `Stripe-Version`, `StripeError` with `definitive` (4xx decline vs
  retryable outage); PaymentIntent create/update/retrieve/confirm/capture/cancel + refund create.
- `fake-stripe.ts`: in-memory `StripeApi` — idempotency map (replay returns the recorded object), call log,
  scriptable declines/capture failures/outages, `clientConfirm` simulating the Payment Element.
- `provider.ts`: the `stripe` `PaymentProvider` — manual-capture intents carrying ids only; session reuse via
  intent update; server-side confirm idempotent on `confirm_<sha256(placement key)>`; amount/currency check;
  declines → `failed` (402 upstream), outages rethrown; refunds with `refund_<key>` idempotency.
- `capture.ts`: `capturePayment(client, paymentId, { actor })` — payment row + `payment.captured` (with
  `fee_minor` from the expanded balance transaction) in one transaction, then the orders module's idempotent
  `markPaymentCaptured`; definitive failure → `payment.failed` + 402; replay converges a half-done capture.
- `orders-seam.ts`: local mirror of `markPaymentCaptured` / `markPaymentFailed` (window 1's PR #174) — becomes
  a re-export from `../orders` when #174 lands on main.

#### 2026-09-09 · follow-ups on the same PR (#183, review + core 2.3 on main)

- `provider.ts`: `authorize` checks the intent's amount and currency BEFORE the server-side confirm, so a stale
  session can never place an authorisation hold for a total the cart no longer has (review finding).
- `provider.ts`: **`void`** implemented for `PaymentProvider.void` (added by core 2.3 / #174) — cancels the
  intent with `void_<sha256(orders' void key)>`; already-cancelled → `voided` (no-op), already-captured →
  `failed` (needs a refund, not a void), outage → rethrow. `voidIdempotencyKey` exported.
- `fake-stripe.ts`: `cancelPaymentIntent` now behaves like Stripe — idempotent replay, and
  `payment_intent_unexpected_state` on an intent that is already `canceled`/`succeeded`; `outageNextCancel`.
- `orders-seam.ts`: the mirror became the promised re-export from `../orders` (#174 is on main).
- `index.ts`: public API + `registerPaymentProviders()` (mount point for src/server.ts, REQUEST #176).
- Tests: `payments.test.ts` (FakeStripe + seeded throwaway DB), `stripe-live.test.ts` (real test mode; skips
  without `STRIPE_SECRET_KEY`).

## 2026-09-19 — migration 0140 landed (contracts-v0.4.2, manager)

- `proposed/0140_webhook_event.sql` deleted; `webhook_event` now comes from `@platform/db` migration 0140 (db 0.3.0). `webhooks.test.ts` no longer applies the DDL itself.
