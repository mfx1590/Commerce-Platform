# hq-rbac (window 2, auth)

HQ role-based access: role (tuple) management routes now, the staff scope middleware (task 1.4) and
`GET /admin/audit-log` (task 1.5) next. Framework-neutral on purpose: window 1 builds `apps/core`
(Medusa 2) at the same time, so this module exposes plain async handlers and a small router instead of
framework routes. All logic that the CLI also needs lives in `@platform/auth-sdk` (`assignRole`, `revokeRole`,
`listRoleAssignments`, `listStaffUsers`, `audit`); this module only adds HTTP semantics and the permission
check.

## Routes (packages/contracts admin-api.yaml, tag `roles`)

| Method | Path                                         | operationId     | x-permission                 |
| ------ | -------------------------------------------- | --------------- | ---------------------------- |
| GET    | `/admin/users`                               | `listUsers`     | `owner` on `organization:hq` |
| GET    | `/admin/users/{userId}/roles`                | `listUserRoles` | `owner` on `organization:hq` |
| POST   | `/admin/users/{userId}/roles`                | `assignRole`    | `owner` on `organization:hq` |
| DELETE | `/admin/users/{userId}/roles/{assignmentId}` | `revokeRole`    | `owner` on `organization:hq` |

Not implemented here: `POST /admin/users` (`inviteUser`, creates the Keycloak user + mirror) — needs a
Keycloak service account; scheduled with the Phase 3 role-admin endpoints.

Assign (ADR 0002 §7), in this order: OpenFGA tuple → `role_assignment` mirror row + `audit_log` row in one
transaction → if the transaction fails, the tuple is deleted again. Revoke is the mirror image (tuple deleted,
then row + audit; tuple restored on failure). Assign is idempotent on the `role_assignment` unique key: a
repeated `POST` answers `201` with the existing assignment and writes no second audit row. Only relations the
model lets a `user` hold directly are accepted (`organization`: owner, finance, operations, analyst, support;
`store`: store_admin, store_staff, support) — anything else is `400 validation_error`.

Responses follow the contract's `Error` shape: `401 unauthorized` (no principal), `403 forbidden` with
`details: { relation, object }` (OpenFGA said no), `404 not_found`, `400 validation_error`, `503` when OpenFGA
is unreachable (fail closed).

### organization:hq ↔ uuid mapping

The contract's `object_id` is always a **uuid** — for organization-level assignments it is the
`organization` row's id (`SEED_IDS.organization` locally). OpenFGA's object ids are the ADR 0002 **slugs**
(`organization:hq`). The mapping lives in exactly one place, `fgaObject()` in `@platform/auth-sdk`
(`src/roles/service.ts`): for `object_type: organization` the uuid is resolved to the row's `slug` under the
caller's tenant scope (`organization:<slug>` — `hq` for the single Phase 0–3 row); a uuid that is not the
caller's organization is a `400`. For `object_type: store` the uuid is verified as a store of the
organization and used directly (`store:<uuid>`). The HTTP API therefore stays uuid-only like every other
route, OpenFGA keeps the frozen slug ids, the `role_assignment` mirror stores the uuid — and no reverse
lookup exists anywhere because tuples are only ever built, never parsed.

## Wiring (for window 1)

```ts
import { createHqRbac } from './modules/hq-rbac/index.js';
const rbac = createHqRbac({
  pool,
  fga: createOpenFgaClient(),
  onRoleChange: scopeCache.invalidate,
});
// in the admin router, after the staff token was verified into a StaffPrincipal (or null):
const res = await rbac.handle({ method, path, principal, query, body, requestId });
if (res) reply.status(res.status).send(res.body); // null = not an hq-rbac path
```

`principal.userId` is the `staff_user.id` (the OpenFGA `user:<id>`), `principal.organizationId` the tenant.
Dependencies: `@platform/auth-sdk`, `@platform/db` only (`apps/core` must list both; REQUEST issue filed).

## Tests

`apps/core/src/modules/hq-rbac/test/roles.test.ts`, run by `pnpm --filter @platform/auth-sdk test` (the
auth-sdk vitest config includes this folder and aliases the workspace packages) against a throw-away Postgres
database (`DATABASE_URL`, seeded) and a throw-away OpenFGA store (`OPENFGA_API_URL`). Skipped when either is
unreachable. Typecheck: `pnpm --filter @platform/auth-sdk typecheck` (runs `tsc -p` on this folder too).

## CLI

`pnpm --filter @platform/auth-sdk roles assign|revoke <email> <relation> <store-code|hq>` and
`roles list <email>` — same service functions, system actor, needs `fga:seed` first.

## Scope middleware (task 1.4)

```ts
import { createStaffScopeMiddleware, toTenantContext } from './modules/hq-rbac/index.js';
const scopeMw = createStaffScopeMiddleware({ pool, fga, organizationId: HQ_ORGANIZATION_ID });
const rbac = createHqRbac({ pool, fga, onRoleChange: scopeMw.invalidate });
// per admin request:
const scope = await scopeMw.resolve(req.headers.authorization); // throws ApiError 401 / 503
const ctx = toTenantContext(scope); // { organizationId, storeIds, actorId, scope: 'organization' | 'store' }
const db =
  ctx.scope === 'organization'
    ? createOrganizationClient(pool, ctx)
    : createTenantClient(pool, ctx); // throws when storeIds is empty → answer 403
const principal = {
  userId: scope.userId,
  subject: scope.subject,
  organizationId: scope.organizationId,
};
```

Steps: verify the JWT against the staff realm JWKS (issuer + `aud: core-api`), `sub → staff_user`
(`keycloak_subject`; unknown or disabled → 401), OpenFGA `ListObjects(store, viewer)` +
`ListRelations(organization:hq)` (unreachable → 503, nothing cached), cache per subject ≤ 30 s, invalidated
by `staff_user.id` on every role change through the tuple API. `last_login_at` is bumped best-effort on each
cache miss. The organization id is deployment configuration (one HQ organization in Phases 0–3).

## GET /admin/audit-log (task 1.5)

Fifth route of `createHqRbac().handle()`. Needs `HqRbacRequest.scope` (the StaffScope from
`createStaffScopeMiddleware`) — without it the route answers 401. Permission per the contract
(`x-permission: viewer on store:{store_id}`): when the `store_id` filter is present it is re-checked against
OpenFGA (403 with `{ relation: 'viewer', object: 'store:<id>' }`); without the filter, visibility comes from
RLS through the caller's own scope — organization scope sees everything including organization-level rows
(`store_id IS NULL`), store scope exactly its stores, an empty store scope 403 (fail closed). Filters:
`store_id`, `entity_type`, `entity_id`, `actor_id`, `from`, `to`, `sort=created_at`, `order`, `page`,
`limit`. Snapshots come back redacted because they are redacted at write time (`@platform/auth-sdk`
`redactPii`).

## GET /admin/finance/ping (task 1.7 — NOT in the contract)

Phase 1 gate test double standing in for the Phase 4 accounting routes: guarded exactly like
`GET /admin/legal-entities` (`finance` on `organization:hq`), answers `{ ok: true }`. Keep it — Phase 4 can
replace it; it costs one routing-table row and proves the finance gate without accounting existing yet.
The gate itself: `test/gate.test.ts` (real Keycloak tokens through the scope middleware; store-admin of two
stores 403 on every finance-gated operation swept from the contract; analyst denied customer PII under the
`support` gate proposed in CONTRACT CHANGE #77).
