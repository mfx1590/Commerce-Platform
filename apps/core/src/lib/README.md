# lib — shared primitives

Owner: window 1 (core). Small, dependency-free helpers every module and route uses. No business logic here.

| File                                                                                                                                        | What                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `db.ts`                                                                                                                                     | the ONLY file that opens a database pool: `initDb()`, `tenantClient(ctx)`, `organizationClient(ctx)`, `closePool()` (`@platform/db`, RLS enforced). ESLint forbids `pg` imports elsewhere. |
| `errors.ts`                                                                                                                                 | `AppError(code, message, details)` with the contract error codes and HTTP status; `mapPgError` turns unique/FK violations into 409/400                                                     |
| `payment-seam.ts` (the `PaymentProvider` types + registry + `manual` provider, re-exported by `src/modules/checkout`; task 2.5), `audit.ts` | `writeAudit(tx, entry)` — one `audit_log` row in the caller's transaction (Phase 1 stub for the auth-sdk helper); `Actor`, `SYSTEM_ACTOR`                                                  |

Tests: covered through the module and HTTP tests (every mutation asserts its `audit_log` row; `AppError` cases in
`src/modules/registry/registry.test.ts`).

## `attribution.ts` (Integration 1)

`parseCartAttribution(cart.metadata)` → `{ first, last }` touches (trimmed, capped at 200 chars, referrer reduced
to its origin, malformed blocks → no touches); `orderMetadataFromCart(cart.metadata)` → the JSON copy the contract
promises on `order.metadata`; `recordAttribution(tx, { organizationId, storeId, orderId, cartId, cartMetadata })`
inserts one `attribution` row per touch and one `attribution.recorded` v1 event per row through the outbox, on
the caller's (placement) transaction. Window 1's checkout task calls it at `POST /store/carts/{id}/complete`;
`campaign_id` is linked at report time by window 17. Tests: `test/attribution.test.ts`.
