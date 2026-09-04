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
