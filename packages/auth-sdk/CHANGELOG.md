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
- REQUEST #82 (manager decision, shipped with task 1.5): `admin-app` registers a second local redirect URI and
  web origin, `http://localhost:3200/*` — window 4's Playwright journey can run with `PORT=3200` when 3000 is
  taken. Dev realm only; production keeps exactly one redirect URI (README dev-only table).
- Task 1.6 (#15): the headline guard API. `can(subject, relation, object)` (with `store:*` = any visible
  store via ListObjects), `allowedStores(subject)`, `resolveScope(subject)`, `requirePermission(relation,
objectFactory)` (string template or function; throws the contract's exact `403 { code: forbidden,
details: { relation, object } }`, 503 fail closed), `resolvePermissionObject` for the `x-permission`
  templates, `verifyStaffToken` / `verifyCustomerToken` conveniences and `createCustomerTokenVerifier`
  (customers-realm JWKS + `store_code` binding: wrong store → 401 store_mismatch). A test sweeps every
  `x-permission` in admin-api.yaml and asserts each is resolvable; unit tests run on a mocked OpenFGA
  client; integration against docker OpenFGA (seeded tuples) and Keycloak. Dev realm: the customers
  `test-cli` client now stamps `store_code=brand-a` so the binding has a live positive path.
- Task 1.7 (#16): PHASE 1 GATE proven end to end. `apps/core/src/modules/hq-rbac/test/gate.test.ts` — real
  Keycloak tokens → scope middleware → x-permission guards: the two-store `store-admin` gets the exact 403 on
  EVERY finance-gated operation of the contract (swept from the spec) and on the new `/admin/finance/ping`
  test-double route (finance on organization:hq, stands in for Phase 4 accounting; finance user gets 200);
  `analyst` keeps viewer reads but is denied customer PII under the `support` gate proposed in
  CONTRACT CHANGE #77 (frozen contract has listCustomers at viewer, which the analyst-PII criterion of #16
  contradicts — support/store_admin/owner keep access, analyst/finance/operations lose it).
- Admin API 0.2.1 (#77 accepted): the gate test now asserts the spec itself carries `support` on
  `listCustomers`/`getCustomer` and builds the customer-PII gate from the parsed contract entry instead of a
  hardcoded proposal.
- Docs fixes (#88 review): `CLAUDE.md` Public API now matches the shipped surface — `verifyCustomerToken(token,
storeCode)` binds by store **code** (not id), plus the roles/audit/bootstrap entries. `resolvePermissionObject`'s
  comment no longer claims non-uuid values are rejected: only MISSING placeholders are 400, a malformed id becomes
  a failing OpenFGA check (403) — pinned by a new test so comment and behaviour cannot drift.

## 0.1.3 — 2026-09-08 (Integration 1, main window)

- `exports["."]` gains a `default` condition (same fix as `@platform/db`, issue #40) so the CommonJS core can
  `require()` the package at runtime under `pnpm dev`; typecheck and vitest were unaffected, the Medusa server was not.

## Unreleased — 2026-10-01 (auth/phase1)

- REQUEST #212: customers realm redirect registrations. `storefront-brand-a` now also accepts brand A's own
  port (`http://localhost:3101/*`) and the exact dev/staging callbacks
  (`https://shop.dev.example.com/auth/callback`, `https://shop.staging.example.com/auth/callback`) with their
  web origins and `https://shop.<env>.example.com/` post-logout redirects; `storefront-brand-b` /
  `storefront-brand-c` move from `:3101` / `:3102` to `:3102` / `:3103` (brand A serves on 3101, so the old
  rows put brand A's origin on brand B's client). `test/keycloak-realms.test.ts` pins the exact lists and the
  rules — off localhost: https, exact URL, no wildcard; one client per origin — plus live checks (sign-in round
  trip from `:3101`, refused look-alikes). Apply with `node infra/keycloak/reimport.mjs customers`.

## Unreleased — 2026-10-02 (auth/phase1)

- REQUEST #307: `CustomerClaims.emailVerified: boolean` — `true` ONLY when the token's `email_verified` claim
  is the boolean `true`; absent, `null`, the string `"true"` or any other value is `false`. Rule for
  consumers: email is identity only when `emailVerified` (the customers realm allows self-registration, so an
  unverified address may belong to someone else). `CustomerTokenVerifierOptions` gains `jwksUri` (tests).
  Realm export: the three storefront clients already carried the `email verified` mapper; the dev/CI-only
  customers `test-cli` did not state it and now does (it emitted the claim only through Keycloak's built-in
  `email` scope). `verifyEmail` stays `false` in the dev export (no SMTP locally; production setting on #297).
  Tests: `test/customer-claims.test.ts` (verified, unverified, absent, string `"true"`, `null`, other truthy
  values; live: jane and a freshly self-registered user), two static realm tests.
- REQUEST #314 (hardening after #313): `createStaffTokenVerifier` — and through it
  `createCustomerTokenVerifier` — throws at construction when `jwksUri` is set and `NODE_ENV === 'production'`.
  Tests in `test/customer-claims.test.ts`: the guard on both verifiers; the default path fetches the JWKS from
  the issuer's own `certs` URL; with `jwksUri` set, a token signed by a different key, expired, from the wrong
  issuer, for the wrong audience or for the wrong store is still a 401; live: a verified user who posts a new
  address to the account API keeps the original one — the realm makes `email` read-only (email is the
  username, usernames are not editable), answers 204 and ignores the value; the reset of `email_verified`
  on a real change was not observed because the change cannot happen. A static realm test pins the two
  settings. Test hygiene: users this file
  registers are tracked by email prefix before the registration POST, and cleanup throws when the admin API
  refuses. `infra/keycloak/README.md`: the Google `trustEmail` sentence now says it is not measured live.

## Unreleased — 2026-10-07 (auth/phase3)

- REQUEST #346 (with window 1): new subpath export `@platform/auth-sdk/testing` — `staffToken(username)` /
  `customerToken(username, password)` (dev-only `test-cli` password grant), `totp`, `OWNER_DEV_TOTP_SECRET`,
  `waitForNextTotpStep`, `ownerTokenFile`, `forgetStaffToken` (for `afterAll`: deletes the file locally, keeps it in CI). `owner` is the one seeded user with TOTP and Keycloak refuses a
  used code, so three live suites signing owner in seconds apart could need the same 30-second code (flaky
  required CI job). `staffToken('owner')` now signs in once and shares the token across processes through
  `$RUNNER_TEMP/staff-owner-token.json` in CI, `~/.cache/platform/staff-owner-token.json` locally
  (override `STAFF_OWNER_TOKEN_FILE`; mode 0600; content
  `{ issuer, access_token }`, written atomically), reused only when the issuer is this stack's, `exp` is at
  least 60 s away and userinfo answers 200; the grant keeps the fallback previous step → current step →
  wait for the next fresh step. `scope.test.ts` and `keycloak-realms.test.ts` use it (the browser
  challenge, which must spend a code, gains the third fallback); the secret literal and the TOTP function
  now live in one file. Tests: `test/staff-token.test.ts` — unit against a fake Keycloak (reuse without a
  grant, other issuer, userinfo 401, refused steps, non-owner, malformed file) + live on the real stack.
- #90 (follow-up of the #89 review), hq-rbac: `GET /admin/finance/ping` left `HQ_RBAC_ROUTES` (now
  `FINANCE_PING_ROUTE`); `createHqRbac` serves it by default everywhere except `NODE_ENV=production` (every
  image sets it) and throws when `financePing: true` is passed under production — dev stacks and the core's
  live suite keep the test double, production never has it. The gate's `x-permission` sweep now cuts the
  spec's `paths:` section into operation blocks instead of matching `x-permission` directly under
  `operationId`: the old regex silently skipped four operations whose description spans several lines
  (`updateDomain`, `revokeApiKey`, `capturePayment`, `buyShipmentLabel`; none finance-gated, so the gate's
  claim held). A static test pins that every `x-permission` line under `paths` is attributed to exactly one
  operation; `test/guard.test.ts` pins the same count for the auth-sdk sweep.
- #402 (nit from the #400 review): both x-permission sweeps (`gate.test.ts`, `guard.test.ts`) now assert that
  every `operationId` under `paths` carries an `x-permission` unless allowlisted — `getMe` only, exact equality in
  both directions, so an unguarded operation fails the gate loudly instead of vanishing from the sweep, and a
  stale allowlist entry fails too. Measured: 113 operations, 112 guarded.
- #406 (follow-up of #346): a refused owner grant now waits `RETRY_GAP_MS` (1.5 s) before the next attempt — the
  staff realm's brute-force protection blocks a user for 60 s after two refused logins within one second, so the
  back-to-back previous/current attempts could make the fresh-step fallback useless (seen locally, 146/147). The
  shared file is deleted once at the end of a local run that created it (`test/global-setup.ts`, vitest
  `globalSetup`) instead of after every test file, so scope.test.ts, the browser challenge and
  staff-token.test.ts spend one grant per run between them instead of three cold grants; `forgetStaffToken()`
  keeps its semantics for a single-file consumer. The fake Keycloak in `test/staff-token.test.ts` enforces the
  quick-login rule and the unit tests pin the gaps and that no block ever forms.

## Unreleased — 2026-10-08 (auth/phase3, task 3.1)

- #415 (a) store object registration: `ensureStoreObject(storeId, { fga?, organization })` writes the
  `organization:<slug>#organization@store:<id>` tuple idempotently (duplicate-tolerant, uuid check 400, OpenFGA
  down 503; no DB, no mirror, no audit); `reconcileStoreObjects` + `pnpm --filter @platform/auth-sdk
fga:reconcile [--fix]` list and repair stores without it. Tests: `test/store-object.test.ts` (unit on a
  scripted client; live on a throw-away store + database).
- #415 (b) `inviteUser` as the contract documents it, behind the new `createKeycloakAdmin()` — the confidential
  service-account client `core-admin` of the staff realm (client-credentials; realm-management manage-users /
  view-users / query-users only; env `KEYCLOAK_ADMIN_CLIENT_ID` / `KEYCLOAK_ADMIN_CLIENT_SECRET`, REQUEST #418 for
  .env.example): Keycloak user (email = username, `UPDATE_PASSWORD` + `CONFIGURE_TOTP`, no password) → `staff_user`
  row + `staff_user.create` audit in one transaction (Keycloak user deleted again on failure) → optional first
  role; 409 on an existing email. The dev staff realm export gains the client and its service-account user
  (`dev-only-core-admin-secret`, allowlisted shape; production strips it in #416). hq-rbac serves
  `POST /admin/users` (owner on organization:hq → 201 StaffUser). Tests: `test/keycloak-admin.test.ts` (unit,
  fake Keycloak), `apps/core/src/modules/hq-rbac/test/invite.test.ts` (live, throwaway user deleted loudly).
- #415 (c) session revocation: `assignRole` / `revokeRole` end the user's Keycloak sessions after the committed
  change (`RolesDeps.keycloak`) and drop the cached scope; a failed logout answers 503 with the change applied.
  Live test: the same store-admin token is refused on the next request, the sessions endpoint is empty, a
  fresh assignment + token works again.

## Unreleased — 2026-10-08 (auth/phase3, task 3.2)

- #416: derived production realm exports. `node infra/keycloak/derive-production.mjs <realm>` derives
  `infra/keycloak/production/<realm>-realm.json` deterministically from the dev export +
  `production/production-profile.json` (public Keycloak URL, one origin + callback per OIDC client, password policy per
  realm): seeded users and `test-cli` removed (client service accounts kept, no credentials), `sslRequired:
all`, `verifyEmail: true`, brute force on, no client secret, exact https callbacks and origins, post-logout
  `<origin>/`, `frontendUrl`, the staff OTP step REQUIRED. `test/production-realms.test.ts` (33 static tests)
  re-derives and compares byte for byte (a hand edit fails), proves determinism and asserts each invariant
  separately. Dev files, `reimport.mjs` and the live CI job are unchanged. README: what still needs a cluster.
- #422 (review follow-up of #421): the role-change logout now runs after the tuple change and BEFORE the
  mirror transaction — a refused logout compensates the tuple and answers 503 with nothing changed, so a
  retry re-runs the whole change including the logout (before: applied first, 503 after, and the retry
  answered 404 / `created: false` without re-attempting the logout). The revocation live test uses a
  throwaway invited user (bootstrap admin sets a dev-only password and clears the required actions) instead
  of logging the shared seeded `store-admin` out; the realm test pins no realm roles / groups on the
  service-account user; `infra/keycloak/README.md` no longer claims there is no confidential client;
  CONTRACT CHANGE #423 adds the `400` response to `inviteUser`.
- Found by the throwaway-user revocation test: an invited user with an empty `lastName` is "not fully set up"
  for Keycloak (the realm's user profile requires both names) and gets no token, not even through the
  direct grant. `createUser` now splits the display name into `firstName` / `lastName` (a one-word name is
  stored as both); `KeycloakStaffUser.lastName` added.
