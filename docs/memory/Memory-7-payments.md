# Memory 7 — Payments, tax, fraud
Window: 7 · Key: `payments` · Branch prefix: `payments/` · Model: Fable (manager decision 2026-09-08: money and attribution)
Last updated: 2026-09-08 · Contracts: contracts-v0.3 (Store API 0.3.0, Admin API 0.3.0, events 0.2.0, db 0.2.0; tagged at the end of Integration 1) · Branch: `payments/phase2` · Status: 2.1 done, PR pending (Phase 2)

## Identity (does not change)
Owned paths (write):
- `apps/core/src/modules/payments/**`
- `apps/core/src/modules/tax/**`
- `apps/core/src/modules/fraud/**`
Reads:
- packages/contracts
- packages/events
Never touches:
- other core modules

## Mission — Phase 2 (Commerce complete, brand 1 live)
Stripe + Adyen providers (hosted fields only), one local PSP, Avalara/Stripe Tax adapter, Radar hooks, idempotent signed webhook handlers with replay protection, per-store credentials from Vault. Test mode only. Wave B — starts when core 2.1–2.2 have merged.

## Done
- **#124 · 2.1 Stripe provider, capture on confirm, per-store credentials — commit ba506bd, PR pending.**
  `apps/core/src/modules/payments/`: fetch-based `StripeClient` (no `stripe` npm dep; window 1 owns package.json), `FakeStripe` (idempotency map + call log), `stripe` PaymentProvider (manual-capture intents, ids-only metadata, session reuse via intent update, server-side confirm idempotent on `confirm_<sha256(placement key)>`, amount/currency check, declines→failed/outages rethrown), `capturePayment` (payment row + `payment.captured` w/ `fee_minor` in one tx, then orders `markPaymentCaptured`; failure → `payment.failed` + 402; replay converges), `stripeCredentialsFor` (store suffix wins, fail-closed naming variables, live keys refused, read-per-call rotation). 23 tests + live suite (skips w/o `STRIPE_SECRET_KEY`). REQUEST #176 filed (window 1: `registerPaymentProviders()` in server boot + `payment.authorized` after the payment insert in `completeCart`).

## In progress
- (nothing — next is 2.2)

## Next — Phase 2 (GitHub issues; acceptance criteria there are authoritative)
- [ ] **#125 · 2.2** Signed webhook receiver with idempotency and replay protection
- [ ] **#126 · 2.3** Refunds
- [ ] **#127 · 2.4** Tax adapter (Stripe Tax) at checkout
- [ ] **#128 · 2.5** Fraud hooks (Radar) and per-store credential pattern

## Decisions made (with reasons)
- 2026-09-08 · **Fetch-based Stripe client, no `stripe` npm package** — the dependency needs window 1's package.json; small REST surface; injectable for tests (accepted by the manager with the 2.1 plan). Same precedent as window 9's Algolia client.
- 2026-09-08 · **Manual capture** — authorize at placement, capture at confirm; `capture_method: 'manual'` on every intent.
- 2026-09-08 · **Session reuse over re-create** — `createSession` on a cart holding a stripe session updates the existing intent (keeps the storefront's Payment Element mounted); unupdatable intents are reused when matching, else best-effort cancelled and replaced.
- 2026-09-08 · **Outage ≠ decline** — only definitive Stripe rejections (4xx, not 429) mark `failed`; 5xx/429/network rethrow with nothing written (retryable).
- 2026-09-08 · **Order transitions via orders module, not direct writes** (manager decision): `capturePayment` calls `markPaymentCaptured`/`markPaymentFailed`; until PR #174 lands they live in `orders-seam.ts` (local mirror, same signatures) — swap to `export … from '../orders'` when merging main after #174.
- 2026-09-08 · **Live-mode keys refused** in `stripeCredentialsFor` (Phase 2 test mode only, decisions.md #10).
- 2026-09-08 · **`requires_action`/`processing` → failed** in authorize (redirect-less card flows in Phase 2; revisit with async payment methods).

## Blocked / waiting
- (none)

## Gotchas learned
- `payment.captured` needs `legal_entity_id` (from the store row) and `fee_minor` (Stripe: expand `latest_charge.balance_transaction` on capture; null when absent).
- Orders wrappers (`markPayment*`) take a ScopedClient and open their OWN transaction — capturePayment therefore runs two transactions (payment+event, then order) and the replay path re-calls the idempotent wrapper so a crash between them converges.
- Prettier: run `pnpm prettier --write` on new module files before `pnpm format:check` (root gate); docs/** is excluded.
- Integration 1 (2026-09-08): real Keycloak staff tokens are the default on the core's Admin API; `CORE_DEV_TOKENS=1` keeps `Bearer dev:<subject>` working locally. The storefront can run against the core with `STORE_API_URL=http://localhost:9000` (+ `CORE_STORE_API_FALLBACK=1` + `CORE_STORE_API_FALLBACK_URL=http://localhost:4010` on the core so unimplemented Store routes still answer from Prism). The admin uses `ADMIN_API_URL`.

## How to run & test this package
- (fill in after first setup: exact commands)
