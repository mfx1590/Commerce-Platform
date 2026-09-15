# Memory 7 — Payments, tax, fraud
Window: 7 · Key: `payments` · Branch prefix: `payments/` · Model: Fable (manager decision 2026-09-08: money and attribution)
Last updated: 2026-09-15 · Contracts: contracts-v0.4.1 on main (v0.3 at Integration 1) · Branch: `payments/phase2` · Status: 2.1 merged (#183 → main d839a93, #124 closed); 2.2 built, PR pending (Phase 2)

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
- **#125 · 2.2 Signed webhook receiver — commit b4bc4b0, PR pending.** `webhook-signature.ts` (raw-body HMAC, ±300 s, constant time, secret-roll aware), `webhook-extract.ts` (redacted extract + `seal` bound to `payload_hash`), `webhook-receiver.ts` (`handleStripeWebhook`: signature → extract → insert-or-skip on `(provider, provider_event_id)` with processing in the same tx; in-flight dup waits at the unique index then 409, takeover after 60 s; state-guarded handlers; conflicts `failed`, late/dup `skipped`; order transitions via orders wrappers + `cancelOrder`; `replayWebhookEvent` refuses a tampered extract), `replay-webhook.ts` CLI, `webhook-router.ts` (`POST /webhooks/stripe/:storeCode`, express.raw), `proposed/0140_webhook_event.sql` (#187, tests only). 18 tests. Mount line posted on #176 (part 3).
- **#124 · 2.1 Stripe provider, capture on confirm, per-store credentials — commit ba506bd; follow-ups e006b1b (authorize-before-check), 9c7901c (`void`, seam re-export), f582505 (capture tests for `payment.authorized`); merged via #183 → main d839a93, #124 closed.**
  `apps/core/src/modules/payments/`: fetch-based `StripeClient` (no `stripe` npm dep; window 1 owns package.json), `FakeStripe` (idempotency map + call log), `stripe` PaymentProvider (manual-capture intents, ids-only metadata, session reuse via intent update, server-side confirm idempotent on `confirm_<sha256(placement key)>`, amount/currency check, declines→failed/outages rethrown), `capturePayment` (payment row + `payment.captured` w/ `fee_minor` in one tx, then orders `markPaymentCaptured`; failure → `payment.failed` + 402; replay converges), `stripeCredentialsFor` (store suffix wins, fail-closed naming variables, live keys refused, read-per-call rotation). 23 tests + live suite (skips w/o `STRIPE_SECRET_KEY`). REQUEST #176 filed (window 1: `registerPaymentProviders()` in server boot + `payment.authorized` after the payment insert in `completeCart`).

## In progress
- (nothing — 2.2 PR opening; next is 2.3)

## Next — Phase 2 (GitHub issues; acceptance criteria there are authoritative)
- [x] **#125 · 2.2** Signed webhook receiver with idempotency and replay protection (PR pending)
- [ ] **#126 · 2.3** Refunds
- [ ] **#127 · 2.4** Tax adapter (Stripe Tax) at checkout
- [ ] **#128 · 2.5** Fraud hooks (Radar) and per-store credential pattern

## Decisions made (with reasons)
- 2026-09-15 · **Webhook extract sealed to `payload_hash`** — `payload_hash` keeps #187's meaning (sha256 of the raw body, shared column with window 8); the extract carries `seal = sha256(payload_hash + '.' + canonical extract)`, so the replay CLI can refuse an edited row without the body ever being stored.
- 2026-09-15 · **In-flight duplicates wait, then 409; takeover after 60 s** — the insert lives in the processing transaction, so a concurrent redelivery blocks on the unique index; a row left `received` by a crash is finished by the next redelivery or the CLI. Never a silent 200 for unfinished work (manager requirement).
- 2026-09-15 · **Webhook conflicts are `failed`, harmless late/dup events are `skipped`** — a Stripe claim that contradicts a terminal state of ours is a money discrepancy that must stay visible; `payment_intent.canceled` goes through the orders module's `cancelOrder` (owner of the cancel; voids via the provider → no-op on an already-cancelled intent), so a shipped order refuses it (409 → event `failed`).
- 2026-09-08 · **Fetch-based Stripe client, no `stripe` npm package** — the dependency needs window 1's package.json; small REST surface; injectable for tests (accepted by the manager with the 2.1 plan). Same precedent as window 9's Algolia client.
- 2026-09-08 · **Manual capture** — authorize at placement, capture at confirm; `capture_method: 'manual'` on every intent.
- 2026-09-08 · **Session reuse over re-create** — `createSession` on a cart holding a stripe session updates the existing intent (keeps the storefront's Payment Element mounted); unupdatable intents are reused when matching, else best-effort cancelled and replaced.
- 2026-09-09 · **A captured payment is never voided**: `PaymentProvider.void` (added by core 2.3) returns `failed` when Stripe reports the intent already `succeeded`, instead of a silent no-op success — a no-op would let `cancelOrder` cancel an order the customer was charged for, and window 1's own `cancelOrder` doc says a captured payment is window 7's to refund. Already-`canceled` stays a no-op success so retries are idempotent. Flagged to the manager as the one deviation from "treat already-cancelled or already-captured as a no-op".
- 2026-09-08 · **Amount check before confirm** (review finding on #183, fixed same day): `authorize` verifies the retrieved intent's amount/currency against the cart BEFORE any server-side confirm — a stale session can never place an authorization hold for the wrong total.
- 2026-09-08 · **Outage ≠ decline** — only definitive Stripe rejections (4xx, not 429) mark `failed`; 5xx/429/network rethrow with nothing written (retryable).
- 2026-09-08 · **Order transitions via orders module, not direct writes** (manager decision): `capturePayment` calls `markPaymentCaptured`/`markPaymentFailed`; until PR #174 lands they live in `orders-seam.ts` (local mirror, same signatures) — swap to `export … from '../orders'` when merging main after #174.
- 2026-09-08 · **Live-mode keys refused** in `stripeCredentialsFor` (Phase 2 test mode only, decisions.md #10).
- 2026-09-08 · **`requires_action`/`processing` → failed** in authorize (redirect-less card flows in Phase 2; revisit with async payment methods).

## Blocked / waiting
- (none)

## Gotchas learned
- supertest/superagent JSON-encodes a Buffer body (`{"type":"Buffer","data":[…]}`) even with `Content-Type: application/json` — a signed raw body must be sent as a STRING (`.send(raw.toString('utf8'))`). Cost an hour on 2.2.
- `express.raw({ type: () => true })` inside the router is what keeps the signed bytes intact; never mount the webhook router behind `express.json()` (told window 1 on #176).
- `webhook_event` does not exist on main until migration 0140 lands: `webhooks.test.ts` applies `proposed/0140_webhook_event.sql` on its throwaway DB (owner pool) right after `seed()`; delete the proposed copy and that line when 0140 merges.
- `payment.captured` needs `legal_entity_id` (from the store row) and `fee_minor` (Stripe: expand `latest_charge.balance_transaction` on capture; null when absent).
- Orders wrappers (`markPayment*`) take a ScopedClient and open their OWN transaction — capturePayment therefore runs two transactions (payment+event, then order) and the replay path re-calls the idempotent wrapper so a crash between them converges.
- Prettier: run `pnpm prettier --write` on new module files before `pnpm format:check` (root gate); docs/** is excluded.
- Integration 1 (2026-09-08): real Keycloak staff tokens are the default on the core's Admin API; `CORE_DEV_TOKENS=1` keeps `Bearer dev:<subject>` working locally. The storefront can run against the core with `STORE_API_URL=http://localhost:9000` (+ `CORE_STORE_API_FALLBACK=1` + `CORE_STORE_API_FALLBACK_URL=http://localhost:4010` on the core so unimplemented Store routes still answer from Prism). The admin uses `ADMIN_API_URL`.

## How to run & test this package
- (fill in after first setup: exact commands)
