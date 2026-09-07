# Memory 2 — Auth & RBAC
Window: 2 · Key: `auth` · Branch prefix: `auth/` · Model: Fable (owner decision 2026-09-04)
Last updated: 2026-09-07 · Contracts: contracts-v0.1 · Merged: 1.1+1.2 (PR #38), #43 follow-up (PR #65), 1.3 (PR #73: c1ae889 + fa5755e + fd07fbe) · On branch unpushed: 1.4 slice = 811bd85 + f9200dc + 59707f9 + this tidy commit (PR next), then 1.5 (sha recorded at its PR) · Status: Phase 1 in progress, parallel mode (worktree `../wt-auth`, branch `auth/phase1`)

## Identity (does not change)
Owned paths (write):
- `packages/auth-sdk/**`
- `infra/keycloak/**`
- `infra/openfga/**`
- `apps/core/src/modules/hq-rbac/**`
Reads:
- packages/contracts (`RELATIONS`, `x-permission` in `openapi/admin-api.yaml`)
- docs/adr/0002-auth-model.md (relation names frozen there; the old pointer `docs/adr/auth.md` is wrong)
- packages/db (`SEED_IDS`, `role_assignment`, `audit_log` in `migrations/0002_organization.sql`)
Never touches:
- apps/admin UI
- apps/storefront*
- anything in apps/core outside `src/modules/hq-rbac/` (window 1 builds apps/core at the same time; my module stays self-contained, its deps live in packages/auth-sdk)

## Mission — Phase 1 (Isolated modules)
Keycloak realms (staff with MFA + SSO, customers per brand), OpenFGA authorization model, tuple management API, scope-resolution middleware (JWT → allowed store_ids + permissions), append-only audit log, and packages/auth-sdk exposing can(user, action, resource) and allowedStores(user). Prove a store_admin of two stores gets 403 on every finance route.
Tasks are GitHub issues #10–#16 ([auth] 1.1–1.7); their acceptance criteria are authoritative.

## Done
- [x] 1.1 (#10) Keycloak realm exports — commit: d95b4b4 (PR #38). `infra/keycloak/staff-realm.json` (browser flow `browser-mfa` with TOTP REQUIRED → forced setup on first login; `admin-app` PKCE public client; `test-cli` dev/CI password-grant client; 7 users with id `seed-<username>` = `staff_user.keycloak_subject`; `hq-sso` disabled OIDC placeholder), `customers-realm.json` (3 PKCE clients with hard-coded `store_code` claim, registration + reset, Google IdP disabled with `${GOOGLE_CLIENT_ID:unset}` placeholders, Jane), `README.md`, `reimport.mjs`. Tests: `packages/auth-sdk/test/keycloak-realms.test.ts` (static + live). Verified live: discovery OK, password grant → `sub=seed-store-admin`, `email`, `aud=core-api`; admin-app password grant → 400; browser login after password → 302 to `required-action?execution=CONFIGURE_TOTP`.
- [x] 1.2 (#11) OpenFGA model — commit: c97bbdf (PR #38, section "Task 1.2"). `infra/openfga/model.fga` (ADR 0002 verbatim), `tuples.seed.json` (11 tuples: 3 `organization:hq organization store:<id>` + 8 user relations, ids = `SEED_IDS`), `README.md`. auth-sdk: `src/fga/{model,client,seed}.ts` → `loadAuthorizationModel`, `loadSeedTuples`, `modelFromDsl`, `createOpenFgaClient`, `seedOpenFga`; `scripts/fga-seed.ts` (`pnpm --filter @platform/auth-sdk fga:seed`, writes `OPENFGA_STORE_ID`/`OPENFGA_MODEL_ID` to root `.env`). Tests `test/openfga-model.test.ts` 14 (static vs `RELATIONS`/`SEED_IDS` + live on a throw-away store: store-admin store_admin brand-a/b only, never finance/viewer on org; owner viewer+store_admin on all 3 stores; listObjects for store-admin = [brand-a, brand-b]). Seed run twice against docker: store `commerce-platform` reused, 0 written.

- [x] #43 follow-up (manager decision) — commit: 1d2dd52 (own PR). Staff realm OTP now CONDITIONAL: `browser-mfa forms` = password REQUIRED + sub-flow `browser-mfa otp` CONDITIONAL (`conditional-user-configured` + `auth-otp-form`); `owner` pre-enrolled with dev TOTP secret `owner-dev-totp-secret-20260905` (Base32 in infra/keycloak/README.md). Tests flipped: static flow-shape + owner-only-enrolled; live store-admin → 302 straight to callback with code=; live owner → OTP form, passes with computed RFC 6238 code. README: MFA paragraph, dev-only table rows (REQUIRED elsewhere), stale-realm symptoms inverted.
- [x] 1.3 (#12) Tuple management — commit: c1ae889 (+ memory fa5755e, tsconfig follow-up fd07fbe) — PR #73 MERGED. auth-sdk `src/roles/service.ts` (`assignRole`/`revokeRole`: tuple → mirror+audit in one tx → tuple compensated on failure; idempotent; `ASSIGNABLE_RELATIONS` from model.fga; `listRoleAssignments`, `listStaffUsers`), `src/audit/write.ts` (`audit(tx, entry)`, org from tx context), `src/types.ts` (`StaffPrincipal`, `ApiError`, `forbidden()`), CLI `scripts/roles.ts`. hq-rbac: `http.ts` (`createHqRbac().handle(req)`: GET /admin/users, GET/POST /admin/users/{id}/roles, DELETE …/{assignmentId}; owner-on-organization:hq, 401/403/404/400/503 per contract), `test/roles.test.ts` (10 tests incl. 403 body for the 2-store admin on every route, audit rows, idempotency, tuple rollback, 503 fail-closed). `inviteUser` deferred to Phase 3.

- [x] 1.4 (#13) Scope middleware — commit: 811bd85 (+ memory f9200dc, TOTP-test hardening 59707f9) — PR opening now. auth-sdk `src/jwt/verify.ts` (`createStaffTokenVerifier()`: jose `createRemoteJWKSet` on the staff realm, RS256, issuer + `aud: core-api`, 401 `{reason}`), `src/scope/resolve.ts` (`resolveRelations(fga,{userId})` = ListObjects(store, viewer) + ListRelations(organization:hq, owner|finance|operations|analyst|support) → `{storeIds, organizationRelations, scope}`, 503 on FGA failure; `StaffScope`, `toTenantContext`, `ScopeCache` TTL clamped ≤ 30 s with `invalidate(staffUserId)`). hq-rbac `scope.ts`: `createStaffScopeMiddleware({pool,fga,organizationId,verifier?,cache?}).resolve(authorizationHeader)` (token → `staff_user` by `keycloak_subject`, unknown/disabled → 401 → OpenFGA → cache; best-effort `last_login_at`), `invalidate` wired as `onRoleChange`. `test/scope.test.ts` 7 live tests (real Keycloak tokens): store-admin → [brand-a, brand-b] + no org relations; finance → organization scope; owner → all 5 relations; cache hit/invalidate/TTL via a counting proxy; unknown sub + disabled → 401; missing/garbage/customers-realm/wrong-audience → 401; OpenFGA down → 503 and nothing cached.
- [x] 1.4 (#13) Scope middleware — commit: 15023c8 (replayed from parked bec3bd2; PR after the 1.3 PR merges). auth-sdk `src/jwt/verify.ts` (`createStaffTokenVerifier()`: staff-realm JWKS via jose, RS256, issuer + `aud: core-api`, 401 `{reason}`), `src/scope/resolve.ts` (`resolveRelations` = ListObjects(store, viewer) + ListRelations(organization:hq) → `{storeIds, organizationRelations, scope}`, 503 on FGA failure; `StaffScope`, `toTenantContext`, `ScopeCache` TTL clamped ≤ 30 s, `invalidate(staffUserId)`). hq-rbac `scope.ts`: `createStaffScopeMiddleware().resolve(authHeader)` (claims → staff_user by `keycloak_subject`, unknown/disabled → 401 → OpenFGA → cache; best-effort `last_login_at`), `invalidate` = `onRoleChange`. `test/scope.test.ts` 7 live tests (real tokens): store-admin → [brand-a, brand-b], finance → org scope, owner → all 5 relations, cache hit/invalidate/TTL, unknown/disabled 401, bad tokens 401, FGA down 503 nothing cached.
- [x] 1.5 (#14) Audit log — commit: on the branch, unpushed (sha recorded when its PR opens, after the 1.4 PR merges). auth-sdk `src/audit/redact.ts` (`redactPii`: email, phone, line1/line2, key_hash + first_name/last_name → "[redacted]", recursive, case-insensitive) applied inside `audit(tx, entry)` at write time; `src/audit/read.ts` `listAuditLog(db, filters)` (visibility purely via the caller's RLS-scoped client). hq-rbac: 5th route `GET /admin/audit-log` (needs `HqRbacRequest.scope`, 401 without; `store_id` filter re-checks `viewer`; empty store scope 403). Tests: 4 redaction units + 7 live (redaction at rest, UPDATE/DELETE denied for platform_app, HQ vs store visibility incl. NULL-store rows, foreign-store filter 403, filters/paging, 400s).

## In progress
- (nothing — waiting: #43-follow-up PR merge, then cherry-pick task 1.3 from `auth/parked-13-14` and open its PR, then 1.4. **Tasks 1.3 and 1.4 are DONE but parked** on local branch `auth/parked-13-14` (1.3 = 9c18c35 + memory 228c6e7, 1.4 = bec3bd2 + memory 8c0a675) because the manager wants one task per PR on this branch; their memory entries return with the cherry-picks. 1.3 PR body must document the organization:hq ↔ organization uuid mapping (fgaObject resolves object_id uuid → organization slug for the tuple). Window 1 applies #48; do NOT touch apps/core/package.json.)

## Next — Phase 1
- [ ] Open PR for 1.3 (cherry-pick 9c18c35 + 228c6e7 from auth/parked-13-14 after the #43 PR merges; document org uuid↔slug mapping in the body)
- [ ] Open PR for 1.4 (cherry-pick bec3bd2 + 8c0a675 after the 1.3 PR merges)
- [ ] 1.3 (#12) Tuple management in hq-rbac: OpenFGA write → mirror `role_assignment` → `audit_log`, rollback tuple on mirror failure; `POST /admin/users/{id}/roles`, `DELETE …/{assignmentId}` (require `owner` on `organization:hq`); CLI `roles assign <email> <relation> <store-code|hq>`.
- [ ] 1.4 (#13) Scope middleware in hq-rbac: JWT (staff JWKS) → `sub` → staff_user → OpenFGA ListObjects(store, viewer) + Check(org relations) → `{ organizationId, storeIds, organizationRelations }`; 30 s per-sub cache invalidated by the tuple API; unknown sub 401; OpenFGA down 503.
- [ ] 1.5 (#14) `audit(tx, {...})` writer in auth-sdk with PII redaction; `GET /admin/audit-log`; test that `UPDATE audit_log` as platform_app is denied.
- [ ] 1.6 (#15) auth-sdk public API: `verifyStaffToken`, `verifyCustomerToken`, `can`, `resolveScope`, `requirePermission` (403 body per contracts); test iterating every `x-permission` in admin-api.yaml.
- [ ] 1.7 (#16) Gate tests: store-admin (brand-a+b) 200 on `GET /admin/stores`, 403 on `GET /admin/legal-entities` and `/admin/finance/ping`; analyst 403 on `GET /admin/stores/{id}/customers` (decide + document analyst↔viewer on customers).

## Decisions made (with reasons)
- MFA lives in the staff realm's **browser flow**, never in per-user required actions (a pending required action breaks the password grant that issue #16's tests need). **Since 2026-09-05 (#43, manager decision) the dev realm's OTP step is CONDITIONAL** — enrolled users are challenged, others pass with the password — so the other windows can use the admin app without enrolling after every reset; `owner` is pre-enrolled (documented dev secret) to keep the challenge path tested. Production realms must restore REQUIRED (README dev-only table). ADR 0002's "MFA required" stands for production; the relaxation is local-dev only.
- Keycloak user ids are set to `seed-<username>` so the JWT `sub` equals the seeded `staff_user.keycloak_subject` with no mapping table; the same for `seed-jane` in customers.
- Tokens carry `aud: core-api` via a custom-audience mapper (no bearer-only client needed); `verifyStaffToken` will check it.
- Customer tokens carry a hard-coded `store_code` claim per storefront client so `verifyCustomerToken(token, storeId)` can bind the token to one store (ADR 0002 §8).
- `test-cli` (password grant) exists in both realms for dev/CI only; README lists it under "dev-only settings, remove elsewhere". No password policy locally because seed passwords equal usernames.
- `@platform/db` and `@platform/contracts` are dependencies of auth-sdk from now on (seed ids, `Relation`, `Queryable` for the audit writer).
- OpenFGA object ids (accepted by the manager, recorded in Memory-main global gotchas): `user:<staff_user.id>` (uuid, not the Keycloak `sub`: survives an IdP/SSO migration and is the key of the `role_assignment` mirror), `organization:hq` (slug, matches `x-permission` in the contract), `store:<store.id>` (uuid, matches `store:{storeId}` route params). Scope middleware (1.4) resolves `sub → staff_user.id` first.
- `fga:seed` writes a new model version on every run (OpenFGA models are immutable) but keeps the store; tuples are diffed against `read()` so re-runs write nothing. `.env` gets both `OPENFGA_STORE_ID` and `OPENFGA_MODEL_ID` (pin checks to the model).
- Task 1.3 split: the tuple/mirror/audit logic and the CLI live in auth-sdk (the CLI must not depend on apps/core, issue #15 forbids that direction); hq-rbac holds only HTTP semantics + permission check, as framework-neutral `handle(req)`/handlers because window 1 is building the Medusa app concurrently and I must not guess its router. Window 1 mounts `rbac.handle()` (README shows how).
- Audit rows: `organization_id` comes from `app.current_organization_id()` inside the caller's tx, actor from the scoped client's `actorId` (`staff`) or `system` when null. No audit row for idempotent no-ops.
- `POST /admin/users/{id}/roles` answers 201 with the existing assignment on repeat (contract has no 200 variant; documented in hq-rbac README).
- Task 1.3 split: tuple/mirror/audit logic + CLI in auth-sdk (CLI must not depend on apps/core); hq-rbac holds only HTTP semantics + permission check, framework-neutral `handle(req)` because window 1 builds the Medusa app concurrently. Window 1 mounts `rbac.handle()` (module README).
- Audit rows: `organization_id` from `app.current_organization_id()` in the caller's tx; actor from the scoped client's `actorId` (`staff`) or `system` when null. No audit row for idempotent no-ops. `POST …/roles` answers 201 with the existing assignment on repeat.
- organization:hq ↔ uuid mapping: the contract's `object_id` is the organization row's **uuid**; `fgaObject()` resolves uuid → `organization.slug` (`hq`) for the tuple object, so the API stays uuid-only while OpenFGA keeps the ADR's slug ids.
- Scope shape: `organizationRelations` = assignable org relations the user holds (owner ⇒ all five), `storeIds` = ListObjects(store, viewer); `scope='organization'` iff any org relation; no relations at all → `scope:'store'`, `storeIds: []` (core answers 403; `createTenantClient` throws on empty).
- HQ organization id is deployment config passed to the middleware, not derived from the token (the staff_user lookup needs a tenant context before the user is known; Phases 0–3 have one organization).
- Cache keyed by Keycloak `sub`, invalidated by `staff_user.id`; TTL hard-clamped to 30 s in `ScopeCache`.
- JWT library: jose 6 (JWKS 10 min cache / 30 s cooldown; error code surfaced as `details.reason`; token never logged).
- Redaction list extends issue #14's minimum (email, phone, line1/line2, key_hash) with first_name/last_name (equally identifying, next to the address lines in the contract's Address shape); ids and status stay readable. Redaction happens at WRITE time so the log never stores PII.
- /admin/audit-log visibility = RLS through the caller's own scoped client — no SQL duplication of the policy; the only explicit OpenFGA check is the contract's `viewer on store:{store_id}` when the filter is present.
- Deps added to auth-sdk: `@openfga/sdk` 0.9.7 (runtime), `@openfga/syntax-transformer` 0.2.2 (DSL → JSON at seed/test time, so only `model.fga` is committed) and `tsx` (runs `scripts/*.ts`; scripts are outside `rootDir`, so not part of the build).

## Blocked / waiting
- (none). REQUEST #48 resolved by window 1 (#61: apps/core depends on @platform/auth-sdk + @platform/db); REQUEST #37 (Keycloak dev-mem loss) fixed on main earlier (dev-file + volume).

## Gotchas learned
- **Owner's password grant needs an OTP since #43** (Keycloak's built-in direct-grant flow validates OTP conditionally, and owner is pre-enrolled): tests send `otp=<RFC 6238 code>` with the grant. Codes are single-use (`otpPolicyCodeReusable: false`) with look-ahead 1, so tests avoid cross-file contention: scope tests use the PREVIOUS window's code (memoized token per user), the realm browser test uses the CURRENT one and retries once with the NEXT window's. CI is unaffected (no Keycloak service → live tests skip).
- **apps/core is CommonJS since the Medusa setup** → the hq-rbac tsconfig pins `module: ESNext` / `moduleResolution: Bundler` / `verbatimModuleSyntax: false` for its noEmit typecheck; without that, tsc treats the module's files as CJS (nearest package.json) and rejects import/export syntax.
- **hq-rbac is typechecked/tested from auth-sdk, not from core** (born as the #48 workaround, kept because it also runs without a built core): the module is typechecked via its own `tsconfig.json` (paths → workspace src) run from auth-sdk's typecheck script, and its tests run from auth-sdk's vitest config (`resolve.alias` + an `include` that reaches `../../apps/core/...`). The module imports only `@platform/auth-sdk`, `@platform/db`(+`/testing`) and vitest — never `@openfga/sdk`/`pg` directly.
- `fga.read({user,relation,object})` is the cheap existence probe before write/delete (OpenFGA 400s duplicate writes and missing deletes).
- vitest `include` accepts `../../apps/core/src/modules/hq-rbac/test/**/*.test.ts` (outside the package root) — that is how the module's tests run in CI.
- **Keycloak realms persist in the `keycloak-data` volume (since main bbb6259).** The file import runs only on the first start of an empty volume. To apply realm JSON changes: `node infra/keycloak/reimport.mjs staff` (admin API, no restart) or `pnpm dev --reset` (wipes every volume, including Postgres — avoid while other windows run). The shared container was started from the main checkout, so it mounts `commerce-platform/infra/keycloak`; the admin-API path does not care about the mount.
- The manager merges main into this worktree while I work (HEAD moved to main's commits mid-task, files changed on disk). Re-check `git log` before committing; do not revert those files.
- Keycloak import: providing only custom `authenticationFlows` is fine, the built-in flows (`browser`, `direct grant`, …) are added automatically; `browserFlow` must name an alias in the file.
- `${VAR:default}` placeholders in realm JSON are resolved only by the startup file import; `reimport.mjs` (admin API) stores them literally (harmless for disabled IdPs).
- If `test-cli` answers `invalid_client` or the browser login skips straight to the app callback, the running Keycloak still has the Phase 0 stub realms: re-import.
- **PR flow (manager decision):** single branch `auth/phase1`, one task per PR, merge commits. Implementation since 1.3: task slices live LINEARLY on the branch; only the slice under review is pushed (`git push origin <slice-end-sha>:auth/phase1`), the rest stays local until its turn. The manager merges main into the remote branch between PRs → rebase the local slices onto the new head (`git rebase --onto origin/auth/phase1 <old-base>`); shas drift, so memory records final shas in the tidy/record commits. The parking branch auth/parked-13-14 is retired.
- Contract tag `contracts-v0.1` is not created in this worktree yet (owner action); reference it by name in PRs.
- Bash tool: the working directory persists between calls; a `cd packages/x` in one call breaks relative paths in the next. Use absolute paths.

## How to run & test this package
- Stack: `pnpm dev` (or `docker compose -f infra/docker/docker-compose.yml up -d --wait keycloak openfga postgres`).
- `pnpm --filter @platform/auth-sdk test` — static realm/model tests always run; live Keycloak tests run when `http://localhost:8180` answers, live OpenFGA tests (throw-away store, deleted afterwards) when `http://localhost:8081` answers.
- `pnpm --filter @platform/auth-sdk fga:seed` — bootstrap the local OpenFGA store after every container restart (memory datastore). Store `commerce-platform`.
- `pnpm lint && pnpm typecheck && pnpm test --filter @platform/auth-sdk` before finishing.
- Realm change loop: edit JSON → `node infra/keycloak/reimport.mjs staff` → tests → restart Keycloak for the clean-import proof.

## Later phases (do not start until Memory-main says so)
### Phase 3 — Multi-store & HQ
Role management UI support: APIs for listing users, assigning stores, finance gate; SSO for HQ.
- [ ] Role admin endpoints
- [ ] SSO config (`hq-sso` placeholder IdP already in the staff realm, disabled)
- [ ] Session revocation on role change
