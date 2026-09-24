# Changelog — fraud module (window 7)

The app-level `apps/core/CHANGELOG.md` and the module row in `apps/core/CLAUDE.md` belong to window 1; this
file is the module's own history (linked from the PRs).

## Phase 2 — payments/phase2 (contracts-v0.4.2)

### 2026-09-24 · final follow-up after core #253 (the post-rollback hook landed; REQUEST #241)

- `check.ts`: the registered check opts in to the checkout's hook (`recordsBlockedAfterRollback: true`) AND
  runs no flush of its own — the two are one setting: `deferredRecord` now defaults to `false`, `evaluate()`
  then remembers nothing, and `completeCart` is the only caller of `recordBlocked`; `registerFraudCheck()`
  forces it off. `deferredRecord: true` keeps the interim (no marker, own flush) for a caller without the hook.
- `check.ts`: the interim's comment no longer claims the flush runs after the ROLLBACK finished — `setImmediate`
  does not guarantee that; the placement never awaits the flush, so it can never wait on the second connection.
- `check.ts`: `pendingBlockRecords()` counts remembered-and-not-yet-written records — the queue plus the batch a
  flush is writing — instead of dropping to 0 the moment a flush took the batch.
- `order-flag.ts`: mirror repair on replay — the same-status paths of `flagOrderForReview` /
  `resolveOrderReview` no longer skip the mirror step, so a payment flagged or resolved before the mirror
  existed (pre-#236 rows) gets its order mirror on the next same signal (payment's own reason and resolution;
  no event when it already matches).
- Tests 16 → 18 (block through `completeCart` now asserts the checkout's hook wrote the row; the interim with a
  gated record client; mirror repair in review and resolved).

### 2026-09-19 · follow-up to 2.5 after core #236 (the checkout seam landed)

- `seam.ts`: the local stand-in registry is gone — `setFraudCheck` / `currentFraudCheck` are re-exports of the
  checkout's, so `registerFraudCheck()` registers where `completeCart` reads and window 1's wiring bridge is a
  no-op (its identity test passes unchanged). `enforceDecision` / `applyDecisionToOrder` removed: the checkout
  does both.
- `order-flag.ts`: the two flag writers now also call the orders module's mirror functions
  (`order.metadata.fraud` + the one `order.updated`), so reviews opened AFTER placement by Radar's webhooks get an
  order mirror; this module no longer emits `order.updated` itself. **A resolved review is never re-flagged.**
- `check.ts`: the block record is written AFTER the placement transaction rolled back (manager decision):
  `evaluate()` writes nothing; `recordBlocked` / `flushBlockRecords` / `pendingBlockRecords` on the check
  (`ModuleFraudCheck`); deferred flush until the checkout calls `recordBlocked` (REQUEST #241).
- `types.ts`: `max_orders` JSDoc says `>=` like the code and the README.
- Tests 14 → 16, block and review now through the real `completeCart`.

### 2026-09-19 · 2.5 Fraud hooks (rules + Stripe Radar), review flag, shared credential loader (#128)

- `types.ts`: `FraudProvider`, `FraudContext` (facts and the checkout's `email_hash` only), `FraudDecision`, a
  closed set of reason codes, `store.settings.fraud` reader (malformed → defaults, never throws), `worse`.
- `rules-provider.ts`: velocity per email hash (SQL-side hash, RLS-scoped, windowed) and mismatched countries;
  rules never block.
- `radar-provider.ts`: Radar's `outcome` on the intent's latest charge (`highest` → block or review per store,
  `manual_review` / `elevated` → review); non-stripe payments are not asked.
- `check.ts`: providers in order, worst outcome wins; **provider outage = `review`** with a log line and
  `fraud_provider_outages_total`; **`block` recorded in `audit_log` in its own transaction** (the Store API answer
  is the plain 402 decline).
- `order-flag.ts`: the review flag lives on `payment.metadata.fraud` (only the orders module may update the
  `"order"` row — its structural guard caught my first draft); `order.updated` goes through the orders module's
  `transition()` with the reason code in `changed_fields`. `seam.ts`: stand-in for the checkout seam (#231).
- `webhooks.ts`: `review.opened` / `review.closed` registered with the payments receiver.
- `metrics.ts`: in-process counters. `index.ts`: `registerFraudCheck()` (boot mount point).
- payments module: shared per-store credential loader (`storeSecretFor` / `requireStoreSecret`),
  `registerWebhookHandler`, Radar outcome on `StripeCharge`, `FakeStripe.setRadarOutcome` / `outageNextRetrieve`,
  `reason` / `closed_reason` in the redacted extract, `capturePayment` refuses orders held for fraud.
- REQUEST #231 to window 1. Tests: `fraud.test.ts` (14). README.
