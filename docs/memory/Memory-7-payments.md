# Memory 7 — Payments, tax, fraud
Window: 7 · Key: `payments` · Branch prefix: `payments/` · Model: Sonnet (strongest for webhook idempotency design)
Last updated: 2026-09-04 · Contracts: (not tagged yet) · Last commit: (none) · Status: not started

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
Stripe + Adyen providers (hosted fields only), one local PSP, Avalara/Stripe Tax adapter, Radar hooks, idempotent signed webhook handlers with replay protection, per-store credentials from Vault. Test mode only.

## Done
- (nothing yet)

## In progress
- (nothing yet)

## Next — Phase 2
- [ ] Provider interface + Stripe impl
- [ ] Adyen impl
- [ ] Local PSP impl
- [ ] Tax adapter
- [ ] Webhook receiver: signature, idempotency key, replay tests
- [ ] Fraud hooks

## Decisions made (with reasons)
- (none yet)

## Blocked / waiting
- (none)

## Gotchas learned
- (none yet)

## How to run & test this package
- (fill in after first setup: exact commands)
