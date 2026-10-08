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
- `jwksUri` on either verifier's options is a test-only override: the constructor throws when it is set and
  `NODE_ENV === 'production'`. In production the keys always come from the issuer's own
  `…/protocol/openid-connect/certs`.
- **Email is identity only when `emailVerified`.** `CustomerClaims.emailVerified` is `true` ONLY when the
  token's `email_verified` claim is the boolean `true`; absent, `null`, the string `"true"` or anything else
  is `false`. The customers realm allows self-registration, so anyone can hold a token whose `email` is an
  address they do not own — never match a customer to existing data (guest orders, another account) by
  `claims.email` unless `claims.emailVerified === true`. `subject` is the only unconditional identity.
- **Email change (#314, measured 2026-10-02 on Keycloak 26.0).** In our customers realm a customer cannot
  change their address: email is the username (`registrationEmailAsUsername: true`) and usernames are not
  editable (`editUsernameAllowed: false`), so the account API reports `email` as read-only, answers 204 to a
  profile update carrying a new address and ignores it; the next token still carries the original address
  with `email_verified: true`. The other safe behaviour — the address moves and Keycloak resets
  `email_verified` to `false` — was **not observed** and cannot be reached with this configuration. If
  either realm setting changes, that reset must be measured before anything relies on it. Only the
  account-console request was measured; an address changed by staff through the admin API was not.

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
- **Session revocation on role change (#415):** with `RolesDeps.keycloak` set (`createKeycloakAdmin()`),
  every assign/revoke ends the user's Keycloak sessions (admin `logout`) right after the tuple change and
  BEFORE the mirror transaction, then drops the cached scope (`onChange`): the very next request is evaluated
  against the new relations and no refresh token survives; the access token itself expires by `exp` (15 min)
  but is already refused by OpenFGA. A refused logout compensates the tuple and answers 503 — nothing has
  changed, so re-issuing the call re-runs the whole change including the logout (#422).
- `inviteUser(deps, { email, displayName, initialRole? })` (#415) — `POST /admin/users` as the contract
  documents it: the Keycloak staff user (email = username, required actions `UPDATE_PASSWORD` +
  `CONFIGURE_TOTP`, no password), then the `staff_user` row with `keycloak_subject` and the
  `staff_user.create` audit row in one transaction (the Keycloak user is deleted again if that fails), then
  the optional first role through `assignRole`. 409 `conflict` when the email exists (here or in Keycloak),
  400 for a malformed email / empty name. The invitation EMAIL is out of scope until SMTP exists
  (Integration 2b): in dev, send it from the Keycloak admin console or `execute-actions-email`.
- `createKeycloakAdmin(opts?)` — the admin API client behind both: the confidential service-account client
  `core-admin` of the staff realm (client-credentials grant; realm-management roles `manage-users`,
  `view-users`, `query-users` and nothing else — never a user password). Env: `KEYCLOAK_URL`,
  `KEYCLOAK_REALM_STAFF`, `KEYCLOAK_ADMIN_CLIENT_ID` (default `core-admin`), `KEYCLOAK_ADMIN_CLIENT_SECRET`
  (no fallback: unset → 503 `identity provider unavailable`; the dev realm export carries the dev-only value,
  production gets its own from Vault, #416). Methods: `createUser`, `getUser`, `logoutUser`,
  `listUserSessions`, `deleteUser` (tests only — the core disables staff users, never deletes them).
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

### Store objects (#415)

A store exists for OpenFGA only once `organization:<slug>#organization@store:<id>` is written — every store
relation derived from the organization (`owner from organization`, `analyst from organization`, …) and so
every HQ user's scope hangs on it. The seed writes it for the three seeded stores; a store created through
the API needs:

- `ensureStoreObject(storeId, { fga?, organization = 'hq' })` → `{ object, organization, created }` — reads
  first, writes only when missing, tolerates a concurrent duplicate write (`created: false`); `storeId` must be
  a uuid (400); OpenFGA unreachable → 503. No DB access, no `role_assignment` mirror, no audit row: call it
  AFTER the store's transaction commits (window 1's onboarding workflow, #413).
- `reconcileStoreObjects(db, { fga?, organization?, fix? })` / `pnpm --filter @platform/auth-sdk fga:reconcile
[--fix]` — lists the stores in the database with no such tuple and writes them with `--fix` (then prints
  the report again: empty on success, exit 1 otherwise; without `--fix` a non-empty report exits 2). Repairs
  any store created before #415.

## Errors

Everything throws `ApiError { status, code, message, details }` matching the contract's `Error` schema
(`unauthorized` 401, `forbidden` 403 with `{ relation, object }`, `validation_error` 400, `not_found` 404,
`internal` 503 for a down authorization service — always fail closed, never allow).

## Tests

`pnpm --filter @platform/auth-sdk test` — 8 files, static parts always run; live parts (docker Keycloak,
OpenFGA, Postgres via `pnpm dev`) skip per-service when unreachable. The suite includes the module tests of
`apps/core/src/modules/hq-rbac` (vitest aliases + cross-package include) and the Phase 1 gate
(`gate.test.ts`). A sweep asserts every `x-permission` in `admin-api.yaml` is resolvable by this package.

**Signing seeded users in from a test** — `import { staffToken } from '@platform/auth-sdk/testing'` (dev/CI
realms only: the `test-cli` password grant, password = username). `owner` is the one user enrolled with TOTP
and Keycloak refuses a used one-time code, so the helper signs owner in once and shares the token between
processes through `$RUNNER_TEMP/staff-owner-token.json` in CI and `~/.cache/platform/staff-owner-token.json`
locally (`STAFF_OWNER_TOKEN_FILE` overrides; mode 0600; content `{ issuer, access_token }`); it is reused only
while this stack's userinfo endpoint accepts it, so a Keycloak restart or realm reimport just costs one new
grant. Every live suite that needs owner must go through it (#346). In this package the file is deleted once at
the end of a local run that created it (`test/global-setup.ts`, vitest `globalSetup`), never per test file —
per-file deletion made every file grant cold again (#406); a package with a single live file may call
`forgetStaffToken()` in its `afterAll` instead (same rule: deletes only what this process wrote, never in CI).
A refused owner grant waits `RETRY_GAP_MS` (1.5 s) before the next attempt: the realm's brute-force
protection blocks a user for 60 s after two refused logins within one second, which would make the fresh-step
fallback useless (#406). Only a test of the TOTP challenge itself spends a code, with `totp` and
`waitForNextTotpStep` from the same module.
