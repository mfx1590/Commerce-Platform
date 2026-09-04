# @platform/auth-sdk

## Purpose

Server-side authorization helpers: Keycloak JWT verification, OpenFGA check/list helpers, request scope resolution (which stores may this principal act on), and the requirePermission guard every mutating route must call.

## Owner

window 2 (auth).

## Run / test

- `pnpm --filter @platform/auth-sdk build` — compile to dist/
- `pnpm --filter @platform/auth-sdk typecheck`
- `pnpm --filter @platform/auth-sdk test` — Vitest (tests live in test/)
- Root: `pnpm lint && pnpm typecheck && pnpm test --filter @platform/auth-sdk` before finishing any task.

## Public API

- `verifyStaffToken(token) → Principal`, `verifyCustomerToken(token, storeId) → CustomerPrincipal`
- `can(principal, relation, object) → Promise<boolean>` e.g. `can(p, 'finance', 'organization:hq')`
- `resolveScope(principal) → { organizationId, storeIds: string[] }`
- `requirePermission(relation, objectFactory)` — route middleware; throws 403
- Relation names are frozen in `infra/openfga/model.fga`

## Constraints

- Import other packages only through their public API (`@platform/<name>`), never `src/*`.
- No secrets in code. No PII in logs. Every DB access through `@platform/db` tenant client.
- Update README.md and CHANGELOG.md with every change.
