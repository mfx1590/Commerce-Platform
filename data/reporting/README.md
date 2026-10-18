# data/reporting — reporting v1 views

Window 12 (data). Issue #478; manager decision 2026-10-16: **option C** — live `security_invoker` views, read through
the tenant-scoped client, exposed as Admin API report operations (#479) and rendered in the admin `(hq)/bi` section
(#480). No Metabase, no reporting role, no materialisation in v1.

## Files

| Path                                                      | What                                                                                                                                                                             |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `proposed/0200_reporting_views.sql`                       | The migration, proposed. The main window lands it in `packages/db/migrations` (db 0.3.8) through the `CONTRACT CHANGE: reporting views` issue; until then this is the only copy. |
| `apps/core/src/modules/reporting/reporting-views.test.ts` | Applies the proposed file to a seeded throwaway database and reconciles every view (fails loudly if this file moves).                                                            |

## Security

- Every view is `WITH (security_invoker = true)`: the base tables' row-level security runs as the **caller**
  (`platform_app` with the tenant client's `app.*` context), not as the view owner. A store session reading a view
  with no `WHERE` gets only its own stores; organization scope (HQ) gets every store; no context gets nothing.
- `platform_app` has `SELECT` and nothing else on the views (0009's default privileges would also grant
  `INSERT/UPDATE/DELETE`; the migration revokes them). No `SECURITY DEFINER` function, no `BYPASSRLS` role.
- No PII: no view has an email, name, phone, address, provider reference, idempotency key, metadata or note column.
  The customer view is counts only. The tests check column names against a denylist.
- Reads `refund`, which is window 7's table, read-only.

## Grain and filters

Days are **UTC calendar days** of the named timestamp (store time zones are a later change). Money is integer minor
units (`bigint`) beside `currency`; every money view groups by currency, so EUR and GBP are never one sum.

| View                  | One row per                        | Day of                | Filter                                                                                                                                      | Columns                                                                                                                                                 |
| --------------------- | ---------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rpt_sales_daily`     | store, day, currency               | `order.placed_at`     | not `cancelled`; `payment_status` not `voided` or `failed` (`awaiting` counts: invoice and manual orders are sales until paid or cancelled) | `orders`, `gross_minor` (subtotal), `discount_minor`, `shipping_minor`, `tax_minor`, `total_minor`, `refunded_minor`, `net_minor`                       |
| `rpt_payments_daily`  | store, day, currency, provider     | `payment.captured_at` | `status = 'captured'`                                                                                                                       | `captured_count`, `captured_minor`, `fee_minor` (known fees, **unreconciled** until Integration 4), `fee_unknown` (captured payments without a fee yet) |
| `rpt_refunds_daily`   | store, day, currency, reason       | `refund.created_at`   | `status = 'succeeded'`                                                                                                                      | `refunds`, `refunded_minor`                                                                                                                             |
| `rpt_stock_position`  | stock item, warehouse (a pool row) | —                     | none                                                                                                                                        | `sku`, `warehouse_code`, `on_hand`, `reserved`, `incoming`, `available`                                                                                 |
| `rpt_customers_daily` | store, day                         | `customer.created_at` | none (every status)                                                                                                                         | `new_customers`, `registered`, `guests`                                                                                                                 |

Every view also carries `organization_id`; all but the stock view carry `store_id`.

`rpt_stock_position` has no store and no currency: it follows the pool's RLS (`inventory_level` kind `pool`,
`stock_item` kind `pool_self`). A store session sees the pool rows of items its own variants map; `reserved` on a
shared item is held by every store that maps it (a number, never another brand's reservation rows).

## Net sales: cohort vs cash

Two views answer two questions about the same refunds:

- `rpt_sales_daily.net_minor` is **cohort-attributed**: `total_minor − refunded_minor`, where `refunded_minor` is every
  succeeded refund of the orders placed that day, whenever the refund happened. A day's net therefore changes when a
  later refund succeeds.
- `rpt_refunds_daily` is the **cash view**: refunds on the day they were created.

Worked example (brand A, EUR). On 2026-03-01 order #1 is placed for 100.00 and an invoice order for 22.00 (still
`awaiting`); a third order is cancelled, a fourth voided, a fifth has a failed payment. On 2026-03-05 25.00 of order
#1 is refunded (a second refund attempt fails).

| View                | Day        | Row                                                                      |
| ------------------- | ---------- | ------------------------------------------------------------------------ |
| `rpt_sales_daily`   | 2026-03-01 | `orders 2`, `total_minor 12200`, `refunded_minor 2500`, `net_minor 9700` |
| `rpt_refunds_daily` | 2026-03-05 | `refunds 1`, `refunded_minor 2500`                                       |

Refunds of excluded orders (for example a cancellation refund) are in `rpt_refunds_daily` but in no sales row.

Reconciliation, as the tests assert: per row `net_minor = total_minor − refunded_minor`; per currency
`sum(net_minor)` = `sum("order".total_minor) − sum(succeeded refund.amount_minor)` over the counted orders;
`rpt_stock_position` matches `inventory_level` row for row.

## Performance

Live views, no materialisation. Report queries are bounded by day per store: `"order"` already has
`order_store_placed_idx (store_id, placed_at DESC)` (0006); the migration adds partial indexes
`payment (store_id, captured_at) WHERE status = 'captured'` and `refund (store_id, created_at) WHERE status = 'succeeded'`.
The dev seed is too small for EXPLAIN to show a seq-scan problem either way; the indexes are there for the bounded
range queries of #479.

## Test

```bash
pnpm --filter @platform/core test -- src/modules/reporting
```

Needs the local Postgres (5433). Use `127.0.0.1`, not `localhost`, in `DATABASE_URL*` if you see `ECONNRESET`.
