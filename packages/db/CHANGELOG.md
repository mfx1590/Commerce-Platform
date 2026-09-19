# Changelog — @platform/db

## 0.1.0 — 2026-09-04

- Scaffold created by the main window (Phase 0).

## 0.1.0 — 2026-09-04 (Phase 0 step 4)

- Migrations 0001–0009: app schema + context functions, organization level, store registry, catalog/pricing, customers, cart/orders/payments/shipments/returns, inventory, ledger, RLS policies + grants.
- `createTenantClient` / `createOrganizationClient` (transaction-local context via set_config), `migrate`, `createPool`, `SEED_IDS`.
- `@platform/db/testing` → `createTestDatabase()`; test/rls.test.ts proves store isolation for the platform_app role (10 cases).

## 0.1.1 — 2026-09-07

- Migration 0110: `app.outbox_lag()` (SECURITY DEFINER, pinned search_path, aggregates only) and the read-only `platform_metrics` role with EXECUTE on it and nothing else. Unblocks the observability outbox-lag panel (infra 2.5) without exposing event payloads or bypassing RLS.

## 0.2.0 — 2026-09-08 (Integration 1, contracts-v0.3)

- Migration 0120: marketing tables per docs/marketing-scope.md — `campaign`, `segment` (organization-level, `store_id NULL` = template, RLS kind `store_nullable`), `segment_member`, `product_feed`, `attribution` (UNIQUE `(order_id, touch)`, written by the core at placement), `referral_program`, `referral`, `review` (rating CHECK 1–5). CHECK constraints on every enum, FKs to store/order/cart/customer/product/promotion/order_line_item/staff_user, `(store_id, …)` indexes, `set_updated_at` triggers. Grants come from 0009's default privileges (no sequences).
- test/rls.test.ts: two marketing cases — store A never sees store B's campaign/attribution rows (and cannot insert for B); segment templates are visible only in organization scope and cannot be created from store scope (12 cases).

## 0.2.1 — 2026-09-08 (CONTRACT CHANGE #162, search merchandising)

- Migration 0130: `merchandising_rule` — pin / boost / bury per category or search query, one row per `(store_id, scope_type, scope_key)` (UNIQUE), `category_id` FK product_category required exactly when `scope_type = category` (CHECK), `pins`/`boosts`/`buries` jsonb arrays (CHECK), `enabled`, `starts_at`/`ends_at` window, `published_at`; RLS kind `store`, `set_updated_at` trigger, grants from 0009's default privileges. The SQL is the proposal from #162 verbatim (window 9 proved it against its throwaway database); the search module now relies on the migration instead of applying the file itself.
- test/rls.test.ts: one merchandising case — store A sees only its own rules, cannot insert for B, the per-scope UNIQUE and the category CHECK hold (13 cases).

## 0.2.2 — 2026-09-14 (CONTRACT CHANGE #189, promotions buy_x_get_y; contracts-v0.4.1)

- Migration 0150: `promotion.type` CHECK widened to `percentage | fixed_amount | free_shipping | buy_x_get_y` — the one db statement of #189 verbatim (window 9 proved it on its throwaway database as its `proposed/0131`; 0140 stays reserved for #187 webhook_event). `stackable` / `exclusive` and the buy-X-get-Y numbers live inside the existing `rules` jsonb column: no new columns. The promotions module now relies on the migration instead of applying the file itself.
- test/rls.test.ts: one promotion case — `buy_x_get_y` inserts, an unknown type is still refused by `promotion_type_check`, store A cannot insert for B (14 cases).

## 0.3.0 — 2026-09-19 (CONTRACT CHANGE #187, webhook_event; contracts-v0.4.2)

- Migration 0140: `webhook_event` — one row per delivered provider webhook (Stripe #125, carrier tracking #131), exactly-once via `UNIQUE (provider, provider_event_id)` (intentionally NOT per store: the same delivery routed to two store endpoints still processes once). `payload` is the consumer's REDACTED extract (never an address, email or name), `payload_hash` the sha256 of the raw body; `occurred_at` nullable provider time kept separate from `received_at`; `status` lifecycle received → processed | skipped | failed with a partial index for retry listings. RLS kind `store`, `set_updated_at` trigger. The SQL is #187's proposal verbatim (both consumers proved it byte-identical on their throwaway databases); the payments and shipping modules now rely on the migration instead of applying their `proposed/` copies.
- test/rls.test.ts: one webhook_event case — store A's rows invisible to B, insert-for-B refused, duplicate `(provider, provider_event_id)` conflicts (15 cases).

## 0.3.1 — 2026-09-19 (CONTRACT CHANGE #225, shipment pick/pack; contracts-v0.4.3)

- Migration 0160: `shipment.status` CHECK widened to include `picking` and `packed` — the one db statement of #225 verbatim (window 8 proved it on its throwaway databases as its `proposed/` copy). No new column: the pick/pack lifecycle is `shipment.status` itself; `shipment.metadata.fulfillment` keeps only the 3PL reference. Forward-only state machine (skips legal, backwards refused) lives in the fulfillment module.
- test/rls.test.ts: pins the widened constraint definition (16 cases).
