# proposed-stock-pool — what #456 is built against

Verbatim copies of window 11's PROPOSED second step of the shared stock pool (CONTRACT CHANGE #453, revision 2,
after the manager's decision of 2026-10-12), read from
`../wt-warehouse/apps/core/src/modules/hq-warehouse/proposed/` at window 11's commit **`aef9f51`** (branch
`warehouse/phase3`, not pushed at the time) and unchanged at its next commit `327eddd`. `0191_stock_pool_rekey.sql`
is byte-identical to the SQL quoted in the body of #453.

| File                        | sha256                                                             |
| --------------------------- | ------------------------------------------------------------------ |
| `0191_stock_pool_rekey.sql` | `8cbbcc0aa9f149074d162e25feada87c1e9d8f121591d8a839c7500ec075d439` |
| `stock.moved.v2.json`       | `f0e65e80e61f6a4808ec464080135621a6fe5e3f6c41ee669518a3e416594c83` |
| `stock_item.mapped.v1.json` | `e399064418f4ebf1c062b0fa0b739989dbe478ee1eeba370858c97a2c3a86b09` |
| `admin-api.stock-pool.yaml` | `32a2e8a83cb3319cba84e47bdfaeab1cda3ede502748a974bbe7f45d28da4a64` |

They are a RECORD, not a second source of truth: `packages/db` (migration 0191 and the seed), `packages/events`
(`stock.moved` v2, `stock_item.mapped` v1) and `packages/contracts` (the Admin API additions) are landed by the
manager as an integration commit on top of this PR's final head, and that commit deletes this folder. Never edit a
file here; a change goes to #453 first.
