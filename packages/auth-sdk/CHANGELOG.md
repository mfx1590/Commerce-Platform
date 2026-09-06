# Changelog — @platform/auth-sdk

## 0.1.0 — 2026-09-04

- Scaffold created by the main window (Phase 0).

## 0.1.1 — 2026-09-04 (unreleased, auth/phase1)

- Task 1.1 (#10): Keycloak realm exports rewritten in `infra/keycloak` — staff realm with mandatory TOTP
  (`browser-mfa` flow), `admin-app` PKCE client, dev/CI-only `test-cli` password-grant client, user ids equal
  to the seeded `staff_user.keycloak_subject`; customers realm with one PKCE client per brand (`store_code`
  claim), registration + reset, disabled Google placeholder. `test/keycloak-realms.test.ts` validates the
  files and, when docker Keycloak answers, real tokens and the forced-TOTP browser login.
- Added workspace dependencies `@platform/db` (seed ids) and `@platform/contracts` (relations).
- Task 1.2 (#11): OpenFGA authorization model `infra/openfga/model.fga` (ADR 0002 relations, verbatim) and
  `tuples.seed.json` (7 seeded users + organization link per store, ids from `SEED_IDS`). New public API:
  `loadAuthorizationModel`, `loadSeedTuples`, `modelFromDsl`, `createOpenFgaClient`, `seedOpenFga`.
  `pnpm --filter @platform/auth-sdk fga:seed` creates/reuses the store, writes model + missing tuples and records
  `OPENFGA_STORE_ID` / `OPENFGA_MODEL_ID` in the root `.env`. Tests: `test/openfga-model.test.ts` (static +
  live on a throw-away store). Dependencies: `@openfga/sdk`, dev `@openfga/syntax-transformer`, `tsx`.

## 0.1.2 — 2026-09-05 (unreleased, auth/phase1)

- #43 follow-up (manager decision): the dev staff realm's OTP step is now CONDITIONAL
  (`browser-mfa forms` → sub-flow `browser-mfa otp` with `conditional-user-configured`), so staff users
  without an enrolled TOTP sign in with the password alone; `owner` is pre-enrolled with a documented
  dev-only TOTP secret so the challenge path stays tested. Flipped the two realm tests (flow shape; live
  browser logins: store-admin → straight to the app callback, owner → OTP challenge passed with a computed
  RFC 6238 code). Production realms must restore REQUIRED (see infra/keycloak/README.md dev-only table).
- Task 1.3 (#12): role/tuple management. `assignRole` / `revokeRole` (OpenFGA tuple first, then `role_assignment`
  mirror + `audit_log` in one transaction, tuple compensated when the transaction fails; idempotent on the mirror's
  unique key; only relations a `user` may hold directly per `model.fga`), `listRoleAssignments`, `listStaffUsers`,
  `validateAssignment`, `ASSIGNABLE_RELATIONS`. First `audit(tx, entry)` writer (append-only, organization from the
  transaction context; redaction comes with task 1.5). Shared types `StaffPrincipal`, `ApiError`, `forbidden()`.
  CLI `pnpm --filter @platform/auth-sdk roles assign|revoke|list …`. The HTTP layer lives in
  `apps/core/src/modules/hq-rbac` (framework-neutral `createHqRbac().handle()`); its tests run from this package's
  vitest config (workspace aliases) against a throw-away Postgres db + OpenFGA store.
- Task 1.4 (#13): staff scope resolution. `createStaffTokenVerifier()` (Keycloak staff-realm JWKS via `jose`,
  RS256, issuer + `aud: core-api` pinned, 401 with a `reason` code), `resolveRelations(fga, { userId })`
  (ListObjects store/viewer + ListRelations on `organization:hq`, 503 when OpenFGA fails), `StaffScope`,
  `toTenantContext()`, `ScopeCache` (per-subject, TTL clamped to ≤ 30 s, `invalidate(staffUserId)`),
  `ORGANIZATION_RELATIONS`. The middleware itself (`createStaffScopeMiddleware`) is in
  `apps/core/src/modules/hq-rbac/scope.ts`. Dependency: `jose`.
- Task 1.5 (#14): audit log completed. `redactPii` (email, phone, address lines line1/line2, key_hash,
  first_name/last_name → "[redacted]", recursive, case-insensitive) applied inside `audit(tx, entry)` at write
  time; `listAuditLog(db, filters)` — the read side of `GET /admin/audit-log` (filters store_id/entity/actor/
  from/to, paging, order; visibility purely via the caller's RLS scope). The route lives in hq-rbac
  (`HqRbacRequest.scope` carries the middleware's StaffScope; a `store_id` filter re-checks `viewer` on that
  store). Tests: redaction units; live: redaction at rest, `UPDATE`/`DELETE audit_log` denied for
  platform_app, HQ sees NULL-store rows, store scope never does, 403 on a foreign store filter.
