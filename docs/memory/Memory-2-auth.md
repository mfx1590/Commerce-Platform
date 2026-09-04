# Memory 2 — Auth & RBAC
Window: 2 · Key: `auth` · Branch prefix: `auth/` · Model: Fable (owner decision 2026-09-04)
Last updated: 2026-09-04 · Contracts: contracts-v0.1 · Last commit: pending (task 1.2; 1.1 = d95b4b4, PR #38) · Status: Phase 1 in progress, parallel mode (worktree `../wt-auth`, branch `auth/phase1`)

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
- [x] 1.2 (#11) OpenFGA model — commit: pending (PR to follow). `infra/openfga/model.fga` (ADR 0002 verbatim), `tuples.seed.json` (11 tuples: 3 `organization:hq organization store:<id>` + 8 user relations, ids = `SEED_IDS`), `README.md`. auth-sdk: `src/fga/{model,client,seed}.ts` → `loadAuthorizationModel`, `loadSeedTuples`, `modelFromDsl`, `createOpenFgaClient`, `seedOpenFga`; `scripts/fga-seed.ts` (`pnpm --filter @platform/auth-sdk fga:seed`, writes `OPENFGA_STORE_ID`/`OPENFGA_MODEL_ID` to root `.env`). Tests `test/openfga-model.test.ts` 14 (static vs `RELATIONS`/`SEED_IDS` + live on a throw-away store: store-admin store_admin brand-a/b only, never finance/viewer on org; owner viewer+store_admin on all 3 stores; listObjects for store-admin = [brand-a, brand-b]). Seed run twice against docker: store `commerce-platform` reused, 0 written.

## In progress
- (nothing — next: task 1.3)

## Next — Phase 1
- [ ] 1.3 (#12) Tuple management in hq-rbac: OpenFGA write → mirror `role_assignment` → `audit_log`, rollback tuple on mirror failure; `POST /admin/users/{id}/roles`, `DELETE …/{assignmentId}` (require `owner` on `organization:hq`); CLI `roles assign <email> <relation> <store-code|hq>`.
- [ ] 1.4 (#13) Scope middleware in hq-rbac: JWT (staff JWKS) → `sub` → staff_user → OpenFGA ListObjects(store, viewer) + Check(org relations) → `{ organizationId, storeIds, organizationRelations }`; 30 s per-sub cache invalidated by the tuple API; unknown sub 401; OpenFGA down 503.
- [ ] 1.5 (#14) `audit(tx, {...})` writer in auth-sdk with PII redaction; `GET /admin/audit-log`; test that `UPDATE audit_log` as platform_app is denied.
- [ ] 1.6 (#15) auth-sdk public API: `verifyStaffToken`, `verifyCustomerToken`, `can`, `resolveScope`, `requirePermission` (403 body per contracts); test iterating every `x-permission` in admin-api.yaml.
- [ ] 1.7 (#16) Gate tests: store-admin (brand-a+b) 200 on `GET /admin/stores`, 403 on `GET /admin/legal-entities` and `/admin/finance/ping`; analyst 403 on `GET /admin/stores/{id}/customers` (decide + document analyst↔viewer on customers).

## Decisions made (with reasons)
- MFA is enforced by the staff realm's **browser flow** (`auth-otp-form` REQUIRED), not by a per-user `CONFIGURE_TOTP` required action. Reason: a pending required action makes the password grant fail ("Account is not fully set up"), which would break the test tokens issue #16 needs; the flow approach forces TOTP setup on first browser login and leaves the direct-grant flow (password only) usable by `test-cli`.
- Keycloak user ids are set to `seed-<username>` so the JWT `sub` equals the seeded `staff_user.keycloak_subject` with no mapping table; the same for `seed-jane` in customers.
- Tokens carry `aud: core-api` via a custom-audience mapper (no bearer-only client needed); `verifyStaffToken` will check it.
- Customer tokens carry a hard-coded `store_code` claim per storefront client so `verifyCustomerToken(token, storeId)` can bind the token to one store (ADR 0002 §8).
- `test-cli` (password grant) exists in both realms for dev/CI only; README lists it under "dev-only settings, remove elsewhere". No password policy locally because seed passwords equal usernames.
- `@platform/db` and `@platform/contracts` are dependencies of auth-sdk from now on (seed ids, `Relation`, `Queryable` for the audit writer).
- OpenFGA object ids: `user:<staff_user.id>` (uuid, not the Keycloak `sub`: survives an IdP/SSO migration and is the key of the `role_assignment` mirror), `organization:hq` (slug, matches `x-permission` in the contract), `store:<store.id>` (uuid, matches `store:{storeId}` route params). Scope middleware (1.4) resolves `sub → staff_user.id` first.
- `fga:seed` writes a new model version on every run (OpenFGA models are immutable) but keeps the store; tuples are diffed against `read()` so re-runs write nothing. `.env` gets both `OPENFGA_STORE_ID` and `OPENFGA_MODEL_ID` (pin checks to the model).
- Deps added to auth-sdk: `@openfga/sdk` 0.9.7 (runtime), `@openfga/syntax-transformer` 0.2.2 (DSL → JSON at seed/test time, so only `model.fga` is committed) and `tsx` (runs `scripts/*.ts`; scripts are outside `rootDir`, so not part of the build).

## Blocked / waiting
- (none). Keycloak `dev-mem` data loss was REQUEST #37 → fixed on main (bbb6259: `KC_DB: dev-file` + `keycloak-data` volume), issue closed.

## Gotchas learned
- **Keycloak realms persist in the `keycloak-data` volume (since main bbb6259).** The file import runs only on the first start of an empty volume. To apply realm JSON changes: `node infra/keycloak/reimport.mjs staff` (admin API, no restart) or `pnpm dev --reset` (wipes every volume, including Postgres — avoid while other windows run). The shared container was started from the main checkout, so it mounts `commerce-platform/infra/keycloak`; the admin-API path does not care about the mount.
- The manager merges main into this worktree while I work (HEAD moved to main's commits mid-task, files changed on disk). Re-check `git log` before committing; do not revert those files.
- Keycloak import: providing only custom `authenticationFlows` is fine, the built-in flows (`browser`, `direct grant`, …) are added automatically; `browserFlow` must name an alias in the file.
- `${VAR:default}` placeholders in realm JSON are resolved only by the startup file import; `reimport.mjs` (admin API) stores them literally (harmless for disabled IdPs).
- If `test-cli` answers `invalid_client` or the browser login skips straight to the app callback, the running Keycloak still has the Phase 0 stub realms: re-import.
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
