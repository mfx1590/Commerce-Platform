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

- `verifyStaffToken(tokenOrHeader) → StaffClaims` — staff-realm JWKS, RS256, issuer + `aud: core-api`; 401 on any failure.
- `verifyCustomerToken(tokenOrHeader, storeCode) → CustomerClaims` — customers realm, and the token's
  `store_code` claim must equal the request's **store code** (`store.code`, e.g. `brand-a`), not a store id:
  the storefront client stamps its brand, and the core resolves publishable key/host → code anyway. A token
  for another brand is 401 `store_mismatch` (ADR 0002 §8).
- `can(subject, relation, object) → Promise<boolean>` e.g. `can(scope, 'finance', 'organization:hq')`;
  `object: 'store:*'` asks "any store this subject can view".
- `allowedStores(subject) → Promise<string[]>` · `resolveScope(subject) → { storeIds, organizationRelations, scope }`
- `requirePermission(relation, objectTemplate | factory)` — route guard; throws the contract's 403
  (`{ code: forbidden, details: { relation, object } }`), 503 fail closed when OpenFGA is unreachable.
- `assignRole` / `revokeRole` / `listRoleAssignments` / `listStaffUsers`; `audit(tx, entry)` (PII-redacted at
  write time) and `listAuditLog(db, filters)`; `seedOpenFga` + `createOpenFgaClient`.
- Subjects are a `StaffScope`/`StaffPrincipal` or the bare `staff_user.id`. Relation names are frozen in
  `infra/openfga/model.fga`; full reference in README.md.

## Constraints

- Import other packages only through their public API (`@platform/<name>`), never `src/*`.
- No secrets in code. No PII in logs. Every DB access through `@platform/db` tenant client.
- Update README.md and CHANGELOG.md with every change.
