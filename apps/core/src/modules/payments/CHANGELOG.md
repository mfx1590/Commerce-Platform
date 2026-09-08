# Changelog — payments module (window 7)

The app-level `apps/core/CHANGELOG.md` and the module row in `apps/core/CLAUDE.md` belong to window 1; this
file is the module's own history (linked from the PRs).

## Phase 2 — payments/phase2 (contracts-v0.3)

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
- `index.ts`: public API + `registerPaymentProviders()` (mount point for src/server.ts, REQUEST #176).
- Tests: `payments.test.ts` (FakeStripe + seeded throwaway DB), `stripe-live.test.ts` (real test mode; skips
  without `STRIPE_SECRET_KEY`).
