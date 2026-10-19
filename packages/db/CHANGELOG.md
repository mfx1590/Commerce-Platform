# Changelog — @platform/db

## 0.3.12 — 2026-10-19

- `0197_customer_identity_link_lock_order.sql`: `app.link_customer_identity` takes the guest merge's locks in one order — the guest's customer rows first (`FOR UPDATE SKIP LOCKED`), the identity second; a guest whose rows another transaction holds is left to that transaction (contention = no merge, #504). Fixes the 40P01 deadlock main's unit job hit at ebb203f on the concurrent guest-merge test. The re-point also filters `organization_id`. Manager fix.

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

## 0.3.2 — 2026-09-20 (CONTRACT CHANGE #244, cart recovery; contracts-v0.4.5)

- Migration 0170: `cart_recovery` (one row per abandoned cart — `UNIQUE (cart_id)` is the replay guard; `token_hash` only, `UNIQUE`, plaintext never stored; `token_expires_at`; `status` pending → redeemed → recovered with `(status='recovered') = (recovered_at IS NOT NULL)`; deliberately NO cross-clock CHECK per the #244 correction — db now() vs an app timestamp breaks on ordinary skew) and `marketing_cursor` (one row per (store, consumer); a durable outbox position instead of one hidden in an external store). Both RLS `store`, `set_updated_at` triggers. The SQL is window 17's proven proposed copy verbatim.
- test/rls.test.ts: marketing_cursor isolation + per-(store,name) UNIQUE, and a cart_recovery constraint-pinning case incl. the absent cross-clock CHECK (18 cases).

## 0.3.2 — seed, 2026-10-06 (no migration, schema version unchanged; window 1 via PR, #350 / #358)

- Seed: every seeded store's `settings` gains `payment: { invoice_allowed: true }`, so `GET /store` offers
  `invoice` (the manual provider) locally — Store API 0.5.4 `Store.payment.methods`. Absent = false, which is
  what a production store gets until someone sets it. `seed` is `ON CONFLICT DO NOTHING`: an existing database
  keeps its rows; set the key by hand there (`UPDATE store SET settings = settings || '{"payment": {"invoice_allowed": true}}'`).

## 0.3.2 — tooling, 2026-10-04 (no migration, schema version unchanged)

- `topUpStock(pool, { floor })` and `pnpm --filter @platform/db top-up-stock [floor]` (default 25): local development only. Test journeys place real
  orders against the shared seed and a placed order keeps its units reserved, so variants run out; `seed` is `ON CONFLICT DO NOTHING` and cannot
  restore them. The top-up raises `on_hand` on every seeded-store level whose `available` is below the floor and writes the same delta to
  `stock_movement` (`adjustment`, note `seed top-up`) in one transaction; reservations are untouched. The CLI refuses a non-loopback database host.
- test/seed.test.ts: one case (drained level, ledger equals the raise, idempotent second run, invalid floor).

## 0.3.3 — 2026-10-07 (CONTRACT CHANGE #393, notification delivery; window 17, #360)

- Migration 0180: `notification_delivery` — one row per outbox event the notifications worker has claimed; `UNIQUE (event_id)` is the exactly-once guard (a re-delivered `order.placed` / `shipment.shipped`, a reset cursor or a re-run from an older position sends nothing). `event_seq` orders attempts; `kind` CHECK `order_confirmation | shipment_shipped`; `status` pending → sent | failed | skipped with `(status='sent') = (sent_at IS NOT NULL)`; `attempts >= 0`; `last_error` is a short provider label only. Deliberately NO recipient column: the address is read from `"order"` at send time and goes to the transport only. RLS kind `store` (forced, `tenant_isolation` policy via `app.apply_rls`, same as 0140/0170), `set_updated_at` trigger, grants from 0009's default privileges. The SQL is #393's proposal verbatim (only the header's first line changed from PROPOSED to landed); the worker's cursor stays a `marketing_cursor` row (0170) named `notifications`.
- test/rls.test.ts: notification_delivery isolation (same-store read/update allowed, cross-store read/update/insert/move refused, organization scope sees both stores, foreign organization sees none, duplicate `event_id` conflicts, sent/sent_at CHECK) and a no-recipient-column pin (20 cases).

## 0.3.4 — 2026-10-12 (CONTRACT CHANGE #453, shared stock pool step 1 of 2; window 11, #435)

- Migration 0190 (EXPAND — nothing reads the new column yet): `stock_item`, the organization-level thing that lies on a shelf (`UNIQUE (organization_id, sku)`), and a nullable `product_variant.stock_item_id`, backfilled 1:1 by `app.backfill_stock_items()` (never an automatic merge; the item's sku is the variant's when unique in the organization, else `<store code>:<sku>`). `inventory_level`, `reservation` and `stock_movement` stay keyed by variant until 0191, which lands together with the inventory module's rewrite.
- `app.apply_rls` gains three kinds; the four existing ones are unchanged. `pool_self` (stock_item) and `pool` (rows carrying `stock_item_id`, used from 0191): organization scope sees every row, a store-scoped session only the rows of an item one of its own stores' variants maps. `pool_ledger` (stock_movement, from 0191) adds the attribution check: a store session reads and writes only movements attributed to its own stores.
- The mapping is the key to the pool, so it is guarded in the database from the migration the column is born in: trigger `guard_variant_stock_item` refuses, for anything that is not exactly organization scope, an INSERT of a variant that arrives already mapped and any change of `stock_item_id` (42501). Fail-closed: a session with no scope is refused too, so owner-role scripts set `app.scope = 'organization'` to map.
- test/rls.test.ts: the pool's isolation (a store sees only the items it maps, cannot update another brand's item, cannot insert a stock item; organization scope sees all; a foreign organization none) and the mapping guard (store scope and a scope-less owner refused on UPDATE and on INSERT; organization scope maps; an ordinary edit of the variant still works).

## 0.3.5 — 2026-10-12 (CONTRACT CHANGE #453, shared stock pool step 2 of 2; window 11 #435, window 1 #456)

- Migration 0191 (REKEY — lands together with the inventory module's rewrite): stock is held per (stock item, warehouse), not per (store's variant, warehouse). The SQL is window 11's proposed file verbatim, except one change from the review of the landing: the trigger reads the product only inside the new variant's own store and organization and refuses the insert otherwise (42501) — in organization scope it could otherwise copy another store's product title into a stock item the inserting store can read.
  - `product_variant.stock_item_id` is NOT NULL (the 0190 backfill runs once more first). Trigger `variant_stock_item` (BEFORE INSERT, `SECURITY DEFINER`, organization scope by the function's own `SET` clause, so no exit path leaves the session elevated; EXECUTE revoked) gives a variant inserted without an item its own, by the backfill's naming rule: the variant's sku when no stock item of the organization carries it, else `<store code>:<sku>`. It sorts after 0190's `guard_variant_stock_item`, which still refuses an already-mapped insert outside organization scope.
  - `inventory_level`: gains `stock_item_id` NOT NULL, `UNIQUE (stock_item_id, warehouse_id)`; `store_id` and `variant_id` are dropped. The migration refuses to run if two levels would share an item and a warehouse (it never sums). RLS kind `store` → `pool`.
  - `reservation`: gains `stock_item_id` NOT NULL and `allocation_rule` (why the allocation chose the warehouse); KEEPS `store_id` and `variant_id`; partial index `reservation_stock_item_idx`. RLS stays `store`. That `stock_item_id` is the item of `variant_id` at reserving time is the inventory module's job, not a constraint (re-mapping keeps history).
  - `stock_movement`: gains `stock_item_id` NOT NULL; `store_id` and `variant_id` become nullable TOGETHER (`stock_movement_store_attribution_check`; both NULL = a pool movement no store caused: receipt, transfer, cycle count); index `stock_movement_stock_item_idx`. RLS kind `store` → `pool_ledger`. Still append-only for `platform_app`.
- So a store session sees the pool row of an item it maps (its `reserved` total included), and never another store's reservations or movements, nor a movement no store caused; organization scope sees all.
- Seed: one shared stock item, `SEED_IDS.sharedStock` (`stockItem`, `variantBrandA`, `variantBrandB`) — brand A's and brand B's first variants both map it, inserted mapped in organization scope; it is always stocked in `wh-eu` (at least 40). Every other variant arrives unmapped and gets its own item from the trigger. Levels are inserted per stock item (brand B's shared rows conflict and are skipped: one pool). `topUpStock` raises the levels of items a seeded store maps and writes store-less movements (`store_id` / `variant_id` NULL). `seed` is `ON CONFLICT DO NOTHING`: an existing local database keeps its 1:1 mapping until it is re-created. Variants that already exist are filtered out before the INSERT: the trigger runs before the conflict is detected, so a re-seed would otherwise leave an orphan stock item per variant (covered by the shared-item seed test: items = variants − 1 after two runs).
- test/rls.test.ts: the real tables after 0191 — `inventory_level` as a pool row (own item only; another brand's level unreadable, not updatable, not insertable; both stores see it once organization scope maps), `stock_movement` as the pool's ledger on a shared item (own attributed movements only; another store's and store-less ones refused and invisible; organization scope does all; the attribution CHECK; append-only), `reservation` still per store on a shared item. The two 0190 cases are unchanged apart from their comments (the trigger maps at insert, the backfill is a no-op). test/seed.test.ts: the level-integrity query follows the stock item.

## 0.3.6 — 2026-10-13 (CONTRACT CHANGE #458, cycle counts; window 11, #436)

- Migration 0192: `cycle_count` — somebody counted a stock item in a warehouse, and what became of the count. The SQL is window 11's proposed file verbatim (it already carries the two changes the decision on #458 required). A count never edits a level: reconciliation (the hq-warehouse module, through the inventory module) turns the difference into exactly one `stock_movement` with reason `cycle_count` and links it in `stock_movement_id` (UNIQUE), which is what makes a second reconcile of the same count a no-op.
  - `status`: `recorded` (written down) → `flagged` (reconciled, the discrepancy is above `organization.settings.warehouse.count_tolerance`; nothing moved, waits for an approval) or `applied`. CHECKs tie the columns together: a reconciled count carries `on_hand_as_of_count`, `delta` and `reconciled_at`; `delta = counted_quantity - on_hand_as_of_count`; a movement is linked exactly when a non-zero delta was applied; `approved_by` and `approved_at` come together and only on an applied count.
  - Required by the decision: a manual count has a counter and a WMS pull has none (`CHECK ((source = 'manual') = (counted_by IS NOT NULL))`), and a count is never deleted (`REVOKE DELETE ON cycle_count FROM platform_app`; UPDATE stays, the row is updated as it is reconciled).
  - One more RLS kind, `organization_only`: the organization's rows in organization scope ONLY — no store session reads or writes a count, not even for an item it maps. `app.apply_rls` is re-created with it; its seven existing kinds are textually unchanged from 0190.
  - Indexes `cycle_count_shelf_idx` (stock item, warehouse, `counted_at DESC`) and the partial `cycle_count_open_idx` (not yet applied).
- No seed change and no new event: reconciliation emits `stock.moved` through the inventory module.
- test/rls.test.ts: the real table — organization scope records, reads and updates a count; a store session (one store, or both) reads none, cannot insert and updates zero rows, although it reads the counted item itself; a context-less connection and another organization read none; DELETE is refused for `platform_app` in every scope (grants are INSERT, SELECT, UPDATE); the counter CHECK both ways; the movement-link CHECK both ways (applied with a non-zero delta needs the movement; recorded, flagged and zero-delta rows refuse one); one movement reconciles one count.

## 0.3.7 — 2026-10-15 (CONTRACT CHANGE #466, Order.payment_status `voided`; contracts-v0.4.17)

- Migration 0193: `"order".payment_status` gains `voided` — drops and re-adds `order_payment_status_check` (the CHECK
  0006 declared inline, auto-named; the name verified in `pg_constraint` on a throwaway database) with the six existing
  values plus `voided`. authorized → voided when `cancelOrder` releases the authorization; terminal. No data update
  and no backfill (manager decision on #466); the core starts writing the value in a later PR.
- test/rls.test.ts: the re-added check keeps its name and carries `voided`; an order row updates to `voided`; unknown
  values (`cancelled`, the payment row's word, and `void`) are still refused by it.

## 0.3.8 — 2026-10-18 (CONTRACT CHANGE #485, reporting views; window 12, #478)

- Migration 0200 reporting views: `rpt_sales_daily`, `rpt_payments_daily`, `rpt_refunds_daily`, `rpt_stock_position`,
  `rpt_customers_daily`; security_invoker, SELECT-only for platform_app; partial indexes payment (store_id,
  captured_at), refund (store_id, created_at). The SQL is window 12's proposed file verbatim (header replaced). Every
  view is `security_invoker = true`, so the base tables' row-level security runs as the caller: a store session sees
  only its own stores' rows, no context sees nothing. No new role, no SECURITY DEFINER, no materialisation. The
  migration revokes everything 0009's default privileges would grant and grants `platform_app` SELECT only. Money
  columns are bigint minor units grouped by currency; no column carries PII. Grain and filters: data/reporting/README.md.
- No seed change and no new event. The views' reconciliation and isolation tests live in the core reporting module
  (window 12); its commit in this landing runs them on the landed migration.

## 0.3.9 — 2026-10-18 (CONTRACT CHANGE #489, customer consent ledger; window 13, #471; contracts-v0.4.21)

- Migration 0194: `customer_consent` — the append-only, store-scoped record of truth for a customer's consent
  decisions (`purpose` = `marketing_email` only until the lawyer review; `granted` boolean; `source`
  `storefront | admin | import`; non-blank `policy_version`; `recorded_at`). The SQL is the issue's diff verbatim
  (header replaced). RLS kind `store`; `REVOKE UPDATE` from `platform_app` (a decision is never edited), DELETE
  kept for erasure; index `customer_consent_customer_idx` (customer, purpose, `recorded_at DESC`).
  `customer.consent` (0005) stays the current-state projection window 17's segments read; the core rewrites it from
  the newest ledger row in the same transaction.
- Backfill: one row per existing `customer.consent.marketing_email` projection with a boolean `granted` (erased
  customers skipped), `recorded_at` = the projection's own `at` (missing → the row's `updated_at`, never now()),
  `source` from the block (unknown/missing → `import`), `policy_version` `'pre-ledger'`. Idempotent: a customer
  with any ledger row for the purpose is skipped. Like 0190's backfill it runs as the migration role, which must
  bypass row security.
- No seed change and no new event.
- test/rls.test.ts: a store session reads and records only its own store's consent rows, another store's are
  invisible (and refused on insert), no context sees none; the purpose and policy-version CHECKs; UPDATE refused
  for `platform_app` in store and organization scope (grants DELETE, INSERT, SELECT); DELETE works in the same store
  and deletes nothing from another. Backfill on its own throwaway database: migrated, then returned to the state
  before 0194 (table dropped, migration unrecorded), seeded with projections (granted, refused, unknown source
  without `at`, never asked, non-boolean, erased); `migrate` applies only 0194 and writes exactly the three expected
  rows; the backfill statement run again adds nothing (33 cases).

## 0.3.10 — 2026-10-18 (CONTRACT CHANGE #498, customer export delivery; window 13, #472; contracts-v0.4.23)

- Migration 0195: `customer_export` — one row per `customer.export_requested` event (`event_id` UNIQUE = the export
  job's idempotency), `requested_by` / `requested_by_type` (`staff | customer`) and `requested_at` from the event,
  `status` `pending | ready | expired` (default `pending`), `reason` (`customer_gone` | `too_large`), `format`, the
  bundle as gzip JSON in `bytea` with `bundle_sha256` and `bundle_size` (compressed bytes) until object storage
  exists (#361), `ready_at` / `expires_at` / `purged_at`, `download_count`. The SQL is the issue's diff verbatim
  (header prepended, the issue-number placeholder filled in). RLS kind `store`; `set_updated_at` trigger; grants
  from 0009's default privileges (UPDATE and DELETE stay: the job moves the status and purges the bundle, erasure
  deletes every export of the customer in the erasure transaction). Indexes `customer_export_customer_idx`
  (customer, `created_at DESC`), partial `customer_export_pending_idx` (store, status) on `pending` and partial
  `customer_export_expiry_idx` (`expires_at`) on `ready`.
- No backfill (the job's first run picks up earlier requests from the outbox), no seed change. The event the job
  emits is events 0.3.6 `customer.export_ready`.
- No rls.test.ts case in this landing (the landing was assembled without a database); the export job's tests in the
  core customers module run on the landed migration.

## 0.3.11 — 2026-10-18 (CONTRACT CHANGE #504, cross-brand identity link; window 13, #473; contracts-v0.4.24)

- Migration 0196: `customer_identity` closed to store sessions and written at last. The SQL is the issue's diff with
  the manager's conditions applied (header prepended, the issue-number placeholder filled in):
  - RLS kind `organization_only` (0192's kind): `apply_rls` drops the existing `tenant_isolation` policy before it
    creates the new one, so 0009's `organization` policy is replaced — a store session reads and writes no identity.
  - Keyed by subject: the inline UNIQUE `customer_identity_organization_id_email_hash_key` (name checked in
    pg_constraint on dev) is dropped; `customer_identity_email_hash_idx` (organization, email_hash) and the partial
    UNIQUE `customer_identity_subject_key` (organization, keycloak_subject) WHERE the subject is set are added. Two
    subjects with the same verified email are two identities.
  - `app.link_customer_identity(p_customer_id, p_subject, p_email_hash) RETURNS uuid` and
    `app.unlink_customer_identity(p_customer_id) RETURNS boolean`: SECURITY DEFINER, pinned `search_path`,
    `SET app.scope = 'organization'` (0191's pattern). Condition 1: no organization parameter — the caller's
    `app.organization_id` is used, and the target customer must be in it and, for a store-scoped caller (non-empty
    `app.store_ids`), in one of the caller's stores; otherwise SQLSTATE 42501 and nothing changes. Condition 2: the
    guest merge locks its candidates `FOR UPDATE` before counting, merges only `WHERE merged_into_id IS NULL`, and
    re-points customers only when that UPDATE hit a row; exactly one candidate merges, two or more never do.
  - EXECUTE revoked from PUBLIC and granted to `platform_app` (0110's pattern).
- No backfill (the table is empty on dev; existing customers are linked on their next verified sign-in), no seed
  change, no event change.
- test/rls.test.ts: one case, as 0192's — the policy is the `organization_only` predicate and the only one on the
  table; organization scope writes and reads identities, two subjects may share an email_hash, a subject is one
  identity; single- and multi-store sessions read, insert and update none; no context and another organization see
  none. The two functions' scope and merge cases (condition 3) are window 13's tests in the core customers module.
  Not run in this landing (assembled without a database).
