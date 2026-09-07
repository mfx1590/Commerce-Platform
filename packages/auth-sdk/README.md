# @platform/auth-sdk

Server-side authorization helpers: Keycloak JWT verification, OpenFGA check/list helpers, request scope resolution (which stores may this principal act on), and the requirePermission guard every mutating route must call.

See CLAUDE.md for run/test commands and the public API. Owner: window 2 (auth).

## Related infrastructure (same owner)

- `infra/keycloak/` — realm exports (`staff` with mandatory TOTP, `customers` per brand) and how to change them.
- `infra/openfga/` — authorization model and seed tuples (task 1.2).

## Tests

`pnpm --filter @platform/auth-sdk test`. Tests that need the docker stack (`pnpm dev`) skip themselves when
the service does not answer: Keycloak at `KEYCLOAK_URL` (default `http://localhost:8180`).

## OpenFGA helpers (task 1.2)

```ts
import { createOpenFgaClient, seedOpenFga, loadAuthorizationModel } from '@platform/auth-sdk';
const client = createOpenFgaClient(); // OPENFGA_API_URL / OPENFGA_STORE_ID / OPENFGA_MODEL_ID from env
await client.check({
  user: 'user:<staff_user.id>',
  relation: 'finance',
  object: 'organization:hq',
});
```

- Ids: `user:<staff_user.id>`, `organization:hq`, `store:<store.id>` (see `infra/openfga/README.md`).
- `pnpm --filter @platform/auth-sdk fga:seed` bootstraps the local store and writes the ids to `.env`.
- OpenFGA tests use a throw-away store per run (`OPENFGA_API_URL`, default `http://localhost:8081`) and skip
  when the server is down.

## Roles (task 1.3)

```ts
import { assignRole, revokeRole, listRoleAssignments, audit } from '@platform/auth-sdk';
const deps = {
  fga: createOpenFgaClient(),
  db: createOrganizationClient(pool, { organizationId, actorId }),
};
await assignRole(deps, {
  staffUserId,
  relation: 'store_admin',
  objectType: 'store',
  objectId: storeId,
});
```

Order (ADR 0002 §7): OpenFGA tuple → `role_assignment` mirror + `audit_log` in one transaction → tuple
compensated if the transaction fails. Idempotent on the mirror's unique key. Only relations a `user` may hold
directly per `infra/openfga/model.fga` are accepted (`ASSIGNABLE_RELATIONS`). HTTP routes: `apps/core/src/modules/hq-rbac`.
CLI: `pnpm --filter @platform/auth-sdk roles assign|revoke <email> <relation> <store-code|hq>`, `roles list <email>`.
`audit(tx, entry)` writes the append-only audit row inside the caller's transaction (`organization_id` from the
tenant context).

## Tokens and scope (task 1.4)

```ts
const verifier = createStaffTokenVerifier(); // KEYCLOAK_URL + KEYCLOAK_REALM_STAFF, aud core-api
const claims = await verifier.verify(req.headers.authorization); // 401 on any failure
const rel = await resolveRelations(fga, { userId: staffUser.id }); // { storeIds, organizationRelations, scope }
```

`ScopeCache` keeps a `StaffScope` per Keycloak subject for at most 30 s; `invalidate(staffUserId)` is wired to
the role API (`onRoleChange`). The full middleware (token → `staff_user` → OpenFGA → cache) lives in
`apps/core/src/modules/hq-rbac` (`createStaffScopeMiddleware`); `toTenantContext(scope)` is what the core hands
to `createTenantClient` / `createOrganizationClient`.

## Audit log (task 1.5)

`audit(tx, entry)` redacts PII in `before`/`after` at write time (`redactPii`; fields in `PII_FIELDS` —
ids and status values stay readable) and writes inside the caller's transaction; `audit_log` is append-only
for the app role (`UPDATE`/`DELETE` are denied by the grants in packages/db). `listAuditLog(db, filters)`
backs `GET /admin/audit-log`: pass the CALLER's scoped client — RLS does the visibility (organization scope
sees every row including `store_id IS NULL`; store scope only its stores). Route + permission handling:
`apps/core/src/modules/hq-rbac`.
