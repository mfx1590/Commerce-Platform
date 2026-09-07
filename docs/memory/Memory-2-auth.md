# Memory 2 — Auth & RBAC

Window: 2 · Key: `auth` · Branch prefix: `auth/` · Model: Fable (owner decision 2026-09-04)
Last updated: 2026-09-07 · Contracts: contracts-v0.1 · Branch `auth/phase1`, worktree `../wt-auth` · Merged PRs: #38 (1.1+1.2), #65 (#43 follow-up), #73 (1.3), #75 (1.4) · Admin API 0.2.1 (CONTRACT CHANGE #77 accepted: customer reads = support)

## Identity (does not change)

Owned paths (write): `packages/auth-sdk/**`, `infra/keycloak/**`, `infra/openfga/**`, `apps/core/src/modules/hq-rbac/**`.
Reads: packages/contracts (`RELATIONS`, `x-permission` in `openapi/admin-api.yaml`), docs/adr/0002-auth-model.md (relation names frozen), packages/db (`SEED_IDS`, `role_assignment`, `audit_log`).
Never touches: apps/admin UI, apps/storefront\*, anything in apps/core outside `src/modules/hq-rbac/` (window 1 builds apps/core concurrently; the module stays self-contained, its deps live in packages/auth-sdk).

## Mission — Phase 1 (Isolated modules)

Keycloak realms (staff with MFA + SSO, customers per brand), OpenFGA authorization model, tuple management API, scope-resolution middleware (JWT → allowed store_ids + permissions), append-only audit log, and packages/auth-sdk exposing can(user, action, resource) and allowedStores(user). Prove a store_admin of two stores gets 403 on every finance route.
Tasks are GitHub issues #10–#16 ([auth] 1.1–1.7); their acceptance criteria are authoritative.

## Done

- [x] 1.1 (#10) Keycloak realm exports — commit d95b4b4 (PR #38, merged). Staff realm with the custom `browser-mfa` flow, `admin-app` PKCE public client, dev/CI-only `test-cli` password-grant client, 7 users with id `seed-<username>` = `staff_user.keycloak_subject`, `hq-sso` disabled placeholder; customers realm with one PKCE client per brand stamping `store_code`, registration + reset, disabled Google placeholder, Jane. `infra/keycloak/README.md` + `reimport.mjs`. Tests: `test/keycloak-realms.test.ts` (static + live).
- [x] #43 follow-up (manager decision 2026-09-05) — commit 1d2dd52 (PR #65, merged). Dev staff realm OTP step CONDITIONAL (`browser-mfa otp` sub-flow with `conditional-user-configured`); `owner` pre-enrolled with the documented dev TOTP secret (`owner-dev-totp-secret-20260905`, Base32 in the README); tests flipped (store-admin → straight to callback; owner → challenged, passes with a computed RFC 6238 code). Production restores REQUIRED (README dev-only table).
- [x] 1.2 (#11) OpenFGA model — commit c97bbdf (PR #38, merged). `infra/openfga/model.fga` (ADR 0002 verbatim), `tuples.seed.json` (11 tuples, ids = `SEED_IDS`), README. auth-sdk: `loadAuthorizationModel`, `loadSeedTuples`, `modelFromDsl`, `createOpenFgaClient`, `seedOpenFga`; `pnpm --filter @platform/auth-sdk fga:seed` writes `OPENFGA_STORE_ID`/`OPENFGA_MODEL_ID` to the root `.env`. Tests: `test/openfga-model.test.ts` (static vs `RELATIONS`/`SEED_IDS` + live on a throw-away store).
- [x] 1.3 (#12) Tuple management — commit c1ae889 + memory fa5755e + tsconfig follow-up fd07fbe (PR #73, merged). auth-sdk `src/roles/service.ts` (`assignRole`/`revokeRole`: OpenFGA tuple → `role_assignment` mirror + `audit_log` in one tx → tuple compensated on failure; idempotent; `ASSIGNABLE_RELATIONS` from model.fga; `listRoleAssignments`, `listStaffUsers`), `src/audit/write.ts` (`audit(tx, entry)`), `src/types.ts` (`StaffPrincipal`, `ApiError`, `forbidden()`), CLI `roles assign|revoke|list`. hq-rbac `http.ts`: framework-neutral `createHqRbac().handle(req)` for the four roles routes (owner on organization:hq, contract error bodies, 503 fail closed). `inviteUser` deferred to Phase 3 (needs a Keycloak service account). Tests: `test/roles.test.ts` (10, live).
- [x] 1.5 (#14) Audit log — commits b92bbf8 + bf635bb + #82 5121bd7 (PR opening now, #75 merged). PII redaction at write time inside `audit(tx, entry)` (`redactPii`: email, phone, line1/line2, key_hash, first_name/last_name → "[redacted]", recursive, case-insensitive; ids and status stay readable); `listAuditLog(db, filters)` + 5th hq-rbac route `GET /admin/audit-log` (needs `HqRbacRequest.scope`, 401 without; `store_id` filter re-checks `viewer` via OpenFGA; org scope sees `store_id IS NULL` rows, store scope never, empty store scope 403). Includes REQUEST #82 (second redirect URI `http://localhost:3200/*` + web origin on `admin-app`, dev realm only — manager decision). Tests: 4 redaction units + 7 live (redaction at rest; `UPDATE`/`DELETE audit_log` as platform_app denied; HQ vs store visibility; foreign-store filter 403; filters/paging; 400s).
- [x] 1.6 (#15) auth-sdk public API — commit: 85c7ace (PR opening now, #85 merged). `src/guard.ts`: `can` (`store:*` = any visible store via ListObjects), `allowedStores`, `resolveScope`, `requirePermission(relation, template|fn)` throwing the contract 403 body, `resolvePermissionObject` for `x-permission` templates, `verifyStaffToken`/`verifyCustomerToken` env-configured singletons; `src/jwt/customer.ts`: `createCustomerTokenVerifier` (customers JWKS + `store_code` binding → 401 store_mismatch/no_store_code). `test/guard.test.ts` 20 tests: sweep of every `x-permission` in admin-api.yaml (each resolvable, relation known), mocked-FGA units (exact 403 body, 503 fail closed everywhere), live integration on a seeded throw-away FGA store, live customer-token binding. Dev realm: customers `test-cli` stamps `store_code=brand-a`.
- [x] 1.7 (#16) PHASE 1 GATE — commit: 0bbc0b9 (+ follow-ups; PR when its turn comes; MERGE gated on infra #87). `gate.test.ts` (7 tests, real Keycloak tokens → scope middleware → guards, seeded throw-away FGA store + Postgres db): store-admin viewer on store:* with scope = exactly [brand-a, brand-b]; **the exact contract 403 on EVERY finance-gated operation swept from admin-api.yaml** and on `/admin/finance/ping` (permanent hq-rbac test-double route, finance on organization:hq; finance user 200); analyst org-scope viewer reads OK, **customer PII denied per Admin API 0.2.1** (`support` on the store — CONTRACT CHANGE #77 accepted), 403 on all finance ops. Gate row "store admin cannot open Finance" PROVEN.
- [x] 1.4 (#13) Scope middleware — commits 811bd85 + memory f9200dc + TOTP-test hardening 59707f9 + README/memory tidy ead0ba4 (PR #75). auth-sdk `src/jwt/verify.ts` (`createStaffTokenVerifier`: staff JWKS via jose, RS256, issuer + `aud: core-api`, 401 with `reason`), `src/scope/resolve.ts` (`resolveRelations` = ListObjects(store, viewer) + ListRelations(organization:hq) → `{storeIds, organizationRelations, scope}`, 503 on FGA failure; `StaffScope`, `toTenantContext`, `ScopeCache` TTL clamped ≤ 30 s, `invalidate(staffUserId)`). hq-rbac `scope.ts`: `createStaffScopeMiddleware().resolve(authHeader)` (claims → `staff_user` by `keycloak_subject`, unknown/disabled → 401 → OpenFGA → cache; `invalidate` wired as `onRoleChange`; best-effort `last_login_at`). Tests: `test/scope.test.ts` (7, live: store-admin → [brand-a, brand-b] no org relations; finance → org scope; owner → all 5; cache hit/invalidate/TTL; 401s; FGA down → 503, nothing cached).

## In progress

- (nothing)

<!-- Done entries continue here as each queued task's PR opens. -->

## Next — Phase 1

- (none — Phase 1 complete once the queued PRs merge; Phase 3 items below)

## Decisions made (with reasons)

- MFA lives in the staff realm's browser flow, never in per-user required actions (a pending required action breaks the password grant the tests need). Since #43 (manager decision) the dev realm's OTP step is CONDITIONAL — enrolled users are challenged, others pass — and `owner` is pre-enrolled to keep the challenge path tested. Production restores REQUIRED (README dev-only table). ADR 0002's "MFA required" stands for production.
- Keycloak user ids are `seed-<username>` so the JWT `sub` equals the seeded `staff_user.keycloak_subject` (no mapping table); tokens carry `aud: core-api` via an audience mapper; customer tokens carry a per-client `store_code` claim so a token binds to one store (ADR 0002 §8). `test-cli` (password grant) is dev/CI-only in both realms.
- OpenFGA object ids (accepted by the manager): `user:<staff_user.id>` (uuid — survives an SSO migration, keys the `role_assignment` mirror), `organization:hq` (slug), `store:<store.id>` (uuid). The contract's `object_id` stays uuid-only; `fgaObject()` maps organization uuid → slug in exactly one place; tuples are only built, never parsed (hq-rbac README).
- `fga:seed` writes a new model version per run (models are immutable) but keeps the store; tuples are diffed so re-runs write nothing.
- Task-1.3 split: tuple/mirror/audit logic + CLI live in auth-sdk; hq-rbac holds only HTTP semantics + permission checks, framework-neutral `handle(req)` because window 1 builds the Medusa app concurrently. Audit rows: `organization_id` from the tx context, actor from the scoped client's `actorId`; no audit row for idempotent no-ops; repeated assign answers 201 with the existing assignment.
- Scope shape: `organizationRelations` = assignable org relations held (owner ⇒ all five), `storeIds` = ListObjects(store, viewer); `scope='organization'` iff any org relation; no relations → `storeIds: []` and the core answers 403 (`createTenantClient` throws on empty). The HQ organization id is deployment config passed to the middleware, not derived from the token. Cache keyed by `sub`, invalidated by `staff_user.id`, TTL hard-clamped to 30 s. JWT library: jose 6.
- Deps added to auth-sdk: `@openfga/sdk` (runtime), `jose` (runtime), `@openfga/syntax-transformer` + `tsx` (dev). `@platform/db` and `@platform/contracts` are workspace deps.

## Blocked / waiting

- Task 1.7's PR merges only after infra's **#87** lands (the CI job running the live suites; closes #80). Open the PR when its turn comes (manager instruction 2026-09-07).
- CONTRACT CHANGE #77: ACCEPTED — Admin API 0.2.1 gates `listCustomers`/`getCustomer` with `support` on the store. The gate tests now assert the real contract.

## Gotchas learned

- **Shared-stack rule (Memory-main, 2026-09-07): nobody restarts or recreates the shared docker stack; realm changes go through `node infra/keycloak/reimport.mjs <realm>` only.** A container recreate from another worktree once wiped my unmerged realm changes mid-run (re-imported to recover) — the rule exists for exactly that. After any unexpected Keycloak recreate, re-run `reimport.mjs` for both realms and `fga:seed` if OpenFGA moved.
- **Keycloak realms persist in the `keycloak-data` volume.** The file import runs only on the first start of an empty volume; apply JSON changes with `node infra/keycloak/reimport.mjs <realm>` or `pnpm dev --reset` (wipes every volume — avoid while other windows run). `${VAR:default}` placeholders resolve only in the startup file import (harmless for disabled IdPs). Only custom `authenticationFlows` need declaring; built-ins are added automatically.
- **Owner's password grant needs an OTP since #43** (built-in direct-grant flow validates OTP conditionally): tests send `otp=<RFC 6238 code>`. Codes are single-use with look-ahead 1, so the test files use different TOTP windows (previous/current/next) to avoid contention. CI is unaffected (no Keycloak service → live tests skip).
- **apps/core is CommonJS since Medusa** → the hq-rbac tsconfig pins `module: ESNext` / `moduleResolution: Bundler` / `verbatimModuleSyntax: false` for its noEmit typecheck. The module is typechecked and tested from auth-sdk (own tsconfig `paths`, vitest `resolve.alias` + cross-package `include`); it imports only `@platform/auth-sdk`, `@platform/db`(+`/testing`) and vitest.
- `fga.read({user,relation,object})` is the cheap existence probe before tuple write/delete (OpenFGA 400s duplicates and missing deletes).
- **PR flow (manager decision):** single branch `auth/phase1`, one task per PR, merge commits. Task slices live linearly on the branch; only the slice under review is pushed (`git push origin <slice-end-sha>:auth/phase1`). The manager merges main into the remote branch between PRs → `git rebase --onto origin/auth/phase1 <old-base>`; shas drift, so Done entries are updated when a slice's PR opens. Memory edits: always guard string replacements (an unguarded regex once left stale duplicate sections in this file — the #75 review blocker).
- The manager merges main into this worktree/branch while I work; re-check `git log` before committing and never revert those files. Bash tool: the working directory persists between calls — use absolute paths.

## How to run & test this package

- Stack: `pnpm dev` (or `docker compose -f infra/docker/docker-compose.yml up -d --wait keycloak openfga postgres redis`).
- `pnpm --filter @platform/auth-sdk test` — static tests always run; live Keycloak/OpenFGA/Postgres tests skip when the service is down. `pnpm --filter @platform/auth-sdk fga:seed` after an OpenFGA restart (memory datastore).
- `pnpm lint && pnpm typecheck && pnpm test --filter @platform/auth-sdk` before finishing; prettier + `scripts/check-ownership.sh` before commits.
- Realm change loop: edit JSON → `node infra/keycloak/reimport.mjs <realm>` → tests.
- CLI: `pnpm --filter @platform/auth-sdk roles assign|revoke|list …`.

## Later phases (do not start until Memory-main says so)

### Phase 3 — Multi-store & HQ

Role management UI support: APIs for listing users, assigning stores, finance gate; SSO for HQ.

- [ ] Role admin endpoints
- [ ] SSO config (`hq-sso` placeholder IdP already in the staff realm, disabled)
- [ ] Session revocation on role change
- [ ] `inviteUser` (`POST /admin/users`, needs a Keycloak service account) — deferred from task 1.3
