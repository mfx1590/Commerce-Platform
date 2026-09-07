# http — the contract HTTP layer

Owner: window 1 (core). Everything `src/server.ts` mounts **ahead of Medusa** through `mountCoreMiddleware(app)`:
request id, contract-header alias, the Store API tenant context, the Store API routes, the Admin API staff
principal, the Admin API routes, and the contract error renderer. Medusa's own routes and middleware come after
and only see what these did not answer.

## Files

| File                       | What                                                                                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `request-id.ts`            | `X-Request-Id` in (or generated) and out; lands in `audit_log.request_id`                                                                                                                                                      |
| `publishable-key-alias.ts` | copies `X-Publishable-Key` to Medusa's `x-publishable-api-key`                                                                                                                                                                 |
| `tenant.ts`                | `storeContextMiddleware`: key → `store_api_key` → `req.tenant` (store-scoped client, default currency); 401                                                                                                                    |
| `staff-auth.ts`            | `staffAuthMiddleware`: bearer token → `staff_user` → `role_assignment` → `req.principal`; `DevTokenVerifier` (`CORE_DEV_TOKENS=1`, never in production); `storeClientFor` / `organizationClientFor` / `visibleStoresClientFor` |
| `permissions.ts`           | `requirePermission(relation, objectFactory)` middleware (auth-sdk signature), `can`, `assertPermission` — Phase 1 stub over `role_assignment` per ADR 0002                                                                     |
| `openapi.ts`               | runtime loader of the frozen OpenAPI docs: `x-permission` per operation, request-body validation (400 `validation_error` with per-field `details`)                                                                             |
| `store-routes.ts`          | `GET /store`, `/store/categories`, `/store/products`, `/store/products/{handle}`                                                                                                                                               |
| `admin-routes.ts`          | `/admin/me`, registry and catalog routes; each: `permission(op)` → `body(op)` → handler → module service                                                                                                                       |
| `errors.ts`                | `coreErrorHandler` (contract `Error` shape) and `handle()` for async handlers                                                                                                                                                  |
| `query.ts`                 | shared query/path parsing (`page`/`limit`, uuid params)                                                                                                                                                                        |
| `types.ts`                 | Express `Request` augmentation: `req.tenant`, `req.principal`                                                                                                                                                                  |

## Rules

- Handlers never touch `pg`; they get a `ScopedClient` from `req.tenant.client`, `storeClientFor(principal, storeId)`,
  `organizationClientFor(principal)` or `visibleStoresClientFor(principal)` and pass it to a module service.
- Every Admin API route's permission and request schema come from `admin-api.yaml` itself — the route file only
  names the `operationId`.
- Errors are `AppError` (`src/lib/errors.ts`); anything else becomes `500 { code: "internal" }` without leaking
  details. No PII in logs.

## Tests

`test/tenant-http.test.ts` (RLS through HTTP, 401/403), `test/store-api.test.ts` and `test/admin-api.test.ts`
(contract replay, every response validated against the OpenAPI components via `test/helpers/openapi.ts`),
`test/publishable-key-alias.test.ts`, `test/guards.test.ts` (structural guards). All run the exact chain
`mountCoreMiddleware` mounts, on a bare Express app over a seeded throwaway database.
