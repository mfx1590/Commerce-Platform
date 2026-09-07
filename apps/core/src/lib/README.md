# lib — shared primitives

Owner: window 1 (core). Small, dependency-free helpers every module and route uses. No business logic here.

| File        | What                                                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `db.ts`     | the ONLY file that opens a database pool: `initDb()`, `tenantClient(ctx)`, `organizationClient(ctx)`, `closePool()` (`@platform/db`, RLS enforced). ESLint forbids `pg` imports elsewhere. |
| `errors.ts` | `AppError(code, message, details)` with the contract error codes and HTTP status; `mapPgError` turns unique/FK violations into 409/400                                                     |
| `audit.ts`  | `writeAudit(tx, entry)` — one `audit_log` row in the caller's transaction (Phase 1 stub for the auth-sdk helper); `Actor`, `SYSTEM_ACTOR`                                                  |

Tests: covered through the module and HTTP tests (every mutation asserts its `audit_log` row; `AppError` cases in
`src/modules/registry/registry.test.ts`).
