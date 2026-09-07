# @platform/auth-sdk

Server-side authorization for the platform (ADR 0002): Keycloak JWT verification, OpenFGA checks and scope
resolution, the `requirePermission` guard every mutating route calls, role (tuple) management, and the
append-only audit writer. Owner: window 2 (auth). Run/test commands: CLAUDE.md.

The HTTP layer that uses all of this lives in `apps/core/src/modules/hq-rbac` (same owner): the staff scope
middleware, the roles routes, `GET /admin/audit-log`, and the module README with window 1's wiring examples.
Related infrastructure: `infra/keycloak/` (realm exports and how to change them), `infra/openfga/`
(authorization model + seed tuples).

## The 60-second integration (window 1)

```ts
import { createOpenFgaClient, verifyStaffToken, requirePermission } from '@platform/auth-sdk';
import {
  createStaffScopeMiddleware,
  createHqRbac,
  toTenantContext,
} from './modules/hq-rbac/index.js';

const fga = createOpenFgaClient(); // OPENFGA_API_URL / OPENFGA_STORE_ID / OPENFGA_MODEL_ID from env
const scopeMw = createStaffScopeMiddleware({ pool, fga, organizationId: HQ_ORGANIZATION_ID });
const rbac = createHqRbac({ pool, fga, onRoleChange: scopeMw.invalidate });

// per admin request:
const scope = await scopeMw.resolve(req.headers.authorization); // ApiError 401 / 503
const ctx = toTenantContext(scope); // → createTenantClient / createOrganizationClient (@platform/db)
const handled = await rbac.handle({
  method,
  path,
  principal: scope,
  scope,
  query,
  body,
  requestId,
});
if (handled) return reply.status(handled.status).send(handled.body); // null = not an hq-rbac route
// any other route: guard it with the contract's x-permission before touching data
await requirePermission('store_admin', 'store:{storeId}')(scope, req.params, { fga });
```

## Identity model (who is `user:<id>`)

- Staff JWT `sub` = `staff_user.keycloak_subject`; the scope middleware maps it to `staff_user.id`, and THAT
  uuid is the OpenFGA `user:<id>` and the `role_assignment.staff_user_id` (stable across an SSO migration).
- OpenFGA objects: `organization:hq` (slug), `store:<store.id>` (uuid). The HTTP contract stays uuid-only:
  `fgaObject()` maps the organization uuid → slug in exactly one place; tuples are only built, never parsed.
- Customers never touch OpenFGA (ADR 0002 §8): their token carries a `store_code` claim bound to one brand.

## API by concern

### Tokens

- `verifyStaffToken(header)` / `createStaffTokenVerifier(opts)` — staff-realm JWKS (jose), RS256, issuer +
  `aud: core-api` pinned; every failure is `ApiError(401)` with a stable `details.reason`; tokens are never
  logged.
- `verifyCustomerToken(header, expectedStoreCode)` / `createCustomerTokenVerifier(opts)` — customers-realm
  JWKS plus the store binding: a token stamped for another brand is 401 `store_mismatch`, a missing claim 401
  `no_store_code`.

### Checks and scope (OpenFGA)

- `can(subject, relation, object, { fga }?)` → boolean. `object === 'store:*'` means "any store the subject
  can view" (ListObjects). Subject: a `StaffScope`/`StaffPrincipal` or the bare `staff_user.id`.
- `allowedStores(subject)` → store ids the subject holds any relation on (`viewer`).
- `resolveScope(subject)` → `{ storeIds, organizationRelations, scope }` (ADR 0002 §4);
  `toTenantContext(scope)` turns a full `StaffScope` into the @platform/db client input.
- `requirePermission(relation, objectTemplate | fn)` → guard that throws the contract's exact
  `403 { code: forbidden, details: { relation, object } }`, or `503` fail closed when OpenFGA is unreachable.
  Templates are the spec's `x-permission` objects verbatim (`organization:hq`, `store:{storeId}`, `store:*`);
  `resolvePermissionObject` fills `{param}` from route params (missing → 400).
- Defaults: the env-configured OpenFGA client and verifiers are memoized per process; pass `{ fga }` or your
  own verifier to override; `resetDefaultOpenFgaClient()` for tests.

### Roles (tuples + mirror + audit, ADR 0002 §7)

- `assignRole(deps, input)` / `revokeRole(deps, input)` — OpenFGA tuple first, then the `role_assignment`
  mirror row and the `audit_log` row in ONE transaction; the tuple change is compensated when the transaction
  fails. Idempotent on the mirror's unique key. Only relations `model.fga` lets a `user` hold directly are
  accepted (`ASSIGNABLE_RELATIONS`); everything else is 400.
- `listRoleAssignments(deps, staffUserId)`, `listStaffUsers(deps, { q, page, limit })`.
- CLI: `pnpm --filter @platform/auth-sdk roles assign|revoke <email> <relation> <store-code|hq>`,
  `roles list <email>`.

### Audit log

- `audit(tx, entry)` — append-only, inside the CALLER's transaction (`Queryable` only, never opens a
  connection); `organization_id` from the tenant context. `before`/`after` are PII-redacted at write time
  (`redactPii`, fields in `PII_FIELDS`: email, phone, line1/line2, key_hash, first/last name → "[redacted]";
  ids and status stay readable) — the log never stores PII. The table refuses `UPDATE`/`DELETE` for the app
  role (packages/db grants).
- `listAuditLog(db, filters)` — the read side of `GET /admin/audit-log`; pass the CALLER's scoped client and
  RLS does the visibility (organization scope sees everything incl. `store_id IS NULL`; store scope its
  stores).

### OpenFGA bootstrap

- `seedOpenFga(opts)` / `pnpm --filter @platform/auth-sdk fga:seed` — creates or reuses the store, writes
  `infra/openfga/model.fga` and the missing seed tuples, records `OPENFGA_STORE_ID`/`OPENFGA_MODEL_ID` in the
  root `.env`. Idempotent; run after an OpenFGA restart (memory datastore).
- `loadAuthorizationModel`, `loadSeedTuples`, `modelFromDsl`, `createOpenFgaClient`.

## Errors

Everything throws `ApiError { status, code, message, details }` matching the contract's `Error` schema
(`unauthorized` 401, `forbidden` 403 with `{ relation, object }`, `validation_error` 400, `not_found` 404,
`internal` 503 for a down authorization service — always fail closed, never allow).

## Tests

`pnpm --filter @platform/auth-sdk test` — 8 files, static parts always run; live parts (docker Keycloak,
OpenFGA, Postgres via `pnpm dev`) skip per-service when unreachable. The suite includes the module tests of
`apps/core/src/modules/hq-rbac` (vitest aliases + cross-package include) and the Phase 1 gate
(`gate.test.ts`). A sweep asserts every `x-permission` in `admin-api.yaml` is resolvable by this package.
