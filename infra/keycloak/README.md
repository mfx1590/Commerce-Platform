# infra/keycloak — realm exports (window 2, auth)

Two realms, imported by the local Keycloak (`quay.io/keycloak/keycloak:26.0`, `start-dev --import-realm`,
`KC_DB=dev-file` persisted in the `keycloak-data` volume) **on the first start of an empty volume only**.
After that the realms live in the volume: a JSON edit is applied with `reimport.mjs` (below) or
`pnpm dev --reset`. **The JSON files are the source of truth; console edits are never exported back
automatically.**

| File                   | Realm       | Who logs in                                           |
| ---------------------- | ----------- | ----------------------------------------------------- |
| `staff-realm.json`     | `staff`     | HQ staff and store admins (admin app, future HQ apps) |
| `customers-realm.json` | `customers` | Shoppers, one public client per brand storefront      |

Local URLs: console `http://localhost:8180` (admin / admin), discovery
`http://localhost:8180/realms/<realm>/.well-known/openid-configuration`, JWKS
`http://localhost:8180/realms/<realm>/protocol/openid-connect/certs`.

## Staff realm

- **MFA: CONDITIONAL in this dev realm (issue #43, manager decision 2026-09-05).** The browser flow is the
  custom `browser-mfa` flow: cookie → corporate SSO redirect (`hq-sso`, disabled placeholder) →
  `browser-mfa forms` = username/password, then the sub-flow `browser-mfa otp` (CONDITIONAL:
  `conditional-user-configured` + OTP form). A user **with** an enrolled TOTP is challenged; a user
  **without** one signs in with the password alone — so the other windows can drive the admin app locally
  without enrolling authenticators after every `pnpm dev --reset`. **Production realms must flip the
  sub-flow wiring back to forced enrolment** (make the OTP execution REQUIRED in `browser-mfa forms`); the
  dev-only table below lists this.
- **`owner` is pre-enrolled** so the challenge path stays testable. Dev-only TOTP secret (raw, HmacSHA1,
  6 digits, 30 s): `owner-dev-totp-secret-20260905`. For an authenticator app enter the Base32 form:
  `N53W4ZLSFVSGK5RNORXXI4BNONSWG4TFOQWTEMBSGYYDSMBV`. Tests compute codes from the raw value
  (`test/keycloak-realms.test.ts`).
- **OTP policy:** TOTP, SHA1, 6 digits, 30 s, look-ahead 1 (works with FreeOTP, Google/Microsoft
  Authenticator).
- **Clients**
  - `admin-app` — public, authorization code + PKCE (S256), no password grant. Registered redirects:
    `http://localhost:3000/*` and `http://localhost:3200/*` (#82 — 3200 is window 4's verification port,
    dev-only: production realms keep exactly one redirect URI). Mappers put `email`, `email_verified`, `preferred_username`, `name` and
    `aud: core-api` in the access token.
  - `test-cli` — **dev/CI only.** Public client with the resource-owner password grant enabled so tests can
    mint real tokens for the seeded users (`grant_type=password&client_id=test-cli&username=…&password=…`).
    The direct-grant flow does not run the browser MFA step, which is what makes this usable in CI. Delete this
    client from any export that is not local.
  - `core-admin` — **confidential service account** the core uses for Keycloak's admin API (#415:
    `inviteUser`, ending a user's sessions on a role change). Standard, implicit and direct flows off, no
    redirects, `fullScopeAllowed: true` (with `false` the service account's roles never reach its token and
    every admin call is 403 — measured); its service-account user `service-account-core-admin` holds the
    realm-management roles `manage-users`, `view-users`, `query-users` and nothing else (`view-users` is a
    Keycloak composite that also grants `query-groups`). Credentials for the
    core: `KEYCLOAK_ADMIN_CLIENT_ID` / `KEYCLOAK_ADMIN_CLIENT_SECRET`; the dev export carries the dev-only
    secret `dev-only-core-admin-secret` (the `dev-only-` shape infra/gitleaks.toml allowlists). Production
    replaces it from Vault (#416).
- **Users** mirror `packages/db` `SEED_IDS.users`: `owner`, `finance`, `operations`, `store-admin`,
  `store-staff`, `support`, `analyst` (email `<username>@example.com`, password = username). Each user's
  Keycloak id is `seed-<username>`, which is exactly the `staff_user.keycloak_subject` the db seed writes, so the
  JWT `sub` maps to the seeded `staff_user` row without a lookup table.
- **Roles are not here.** Nothing about permissions lives in Keycloak; OpenFGA holds the relations (ADR 0002,
  `infra/openfga/model.fga`).
- Sessions: access token 15 min, SSO idle 30 min, max 10 h, refresh-token rotation on.

## Customers realm

- **Customers cannot change their email (#314).** `registrationEmailAsUsername: true` with
  `editUsernameAllowed: false` makes `email` read-only in the account console (measured: the account API
  answers 204 and ignores a new address). Do not change either setting without first measuring that an email
  change resets `email_verified` — auth-sdk's `emailVerified` rule depends on it.
- Self-registration (email as username), password reset, remember-me. Email verification is off locally
  (no SMTP); turn `verifyEmail` on where an SMTP server is configured.
- **`email_verified` claim (#307).** Every client carries the `email verified` mapper (user property
  `emailVerified` → boolean claim in the access token), so a token always states it: `true` for the seeded
  Jane, `false` for anyone who self-registers locally (nothing verifies the address while `verifyEmail` is
  off). The `google` provider has `trustEmail: true`: Keycloak is expected to mark a user created through it as
  verified at first broker login, and the same mapper would emit that — **not measured live, the provider is
  disabled**; it must be tested before the provider is enabled (#297). auth-sdk surfaces it as `CustomerClaims.emailVerified`;
  email is identity only when it is true.
- One public PKCE client per brand. Each client hard-codes a `store_code` claim (`brand-a` …) and `aud: core-api`
  so the core can bind a customer token to one store (ADR 0002 §8) — which is also why an origin is
  registered on exactly one client (`test/keycloak-realms.test.ts` enforces it).

  | Client               | Redirect URIs                                                                                  | Served by                                         |
  | -------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------- |
  | `storefront-brand-a` | `http://localhost:3100/*`, `http://localhost:3101/*`                                           | the starter (`:3100`) and brand A (`:3101`, #212) |
  |                      | `https://shop.dev.example.com/auth/callback`, `https://shop.staging.example.com/auth/callback` | the storefront on dev / staging (`infra/helm`)    |
  | `storefront-brand-b` | `http://localhost:3102/*`                                                                      | brand B, once cloned                              |
  | `storefront-brand-c` | `http://localhost:3103/*`                                                                      | brand C, once cloned                              |

  Web origins are the origins of those URIs, spelled out (no `*`, no `+`). Post-logout redirects: the same
  `http://localhost:<port>/*` locally and exactly `https://shop.<env>.example.com/` on dev/staging — the
  storefront's sign-out sends `<origin>/`. **Rule for anything that is not localhost: `https`, the exact
  callback URL, no wildcard anywhere.** A new environment or brand host is a new exact entry here, never a
  pattern. After editing: `node infra/keycloak/reimport.mjs customers`.

- `test-cli` (dev/CI only) as above — it also stamps `store_code=brand-a` so `verifyCustomerToken` has a live positive path in tests.
- Social login: `google` identity provider present but **disabled**; its client id/secret come from the
  environment (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`) via realm-import placeholders. Enable it by setting
  the variables and flipping `enabled` to `true`.
- Seed user: `jane@example.com` / `jane` (id `seed-jane`).

## Dev-only settings (must change outside local)

| Setting                                  | Local value                  | Elsewhere                               |
| ---------------------------------------- | ---------------------------- | --------------------------------------- |
| `sslRequired`                            | `external`                   | `all` behind TLS                        |
| OTP step in `browser-mfa forms` (#43)    | CONDITIONAL                  | REQUIRED (forced enrolment)             |
| `owner` pre-enrolled TOTP credential     | documented secret above      | remove; no committed OTP secrets        |
| Seeded users with password = username    | present                      | remove the `users` array                |
| `test-cli` client (password grant)       | present                      | remove                                  |
| `core-admin` client secret (#415)        | `dev-only-core-admin-secret` | generated, from Vault                   |
| Password policy                          | none (seed passwords)        | e.g. `length(12) and notUsername and …` |
| `verifyEmail` (customers)                | `false`                      | `true` with SMTP configured             |
| `attributes.frontendUrl`                 | `http://localhost:8180`      | the public Keycloak URL                 |
| Redirect URIs / web origins              | `http://localhost:*`         | the real app origins                    |
| `hq-sso` / `google` identity providers   | disabled placeholders        | real client ids from the environment    |
| `admin-app` second redirect (:3200, #82) | registered                   | exactly one redirect URI per app        |
| `storefront-brand-a` redirects (#212)    | localhost + dev + staging    | only that environment's own callback    |
| Keycloak `KC_DB=dev-file` + volume       | one-shot import, persisted   | Postgres                                |

## Production profile (#416, LAUNCH.md section 3.2)

The production realms are DERIVED, never written by hand:

```bash
node infra/keycloak/derive-production.mjs staff
node infra/keycloak/derive-production.mjs customers
```

reads the dev export and `production.config.json` (the public Keycloak URL, exactly one origin + callback
per OIDC client, the password policy per realm) and writes `production/<realm>-realm.json` through the
repo's prettier, so two runs give identical bytes. `packages/auth-sdk/test/production-realms.test.ts`
re-derives and compares byte for byte — a hand edit of a derived file fails CI — and asserts every row of
the table above as its own assertion: no seeded user (only client service accounts, without credentials
or email), no `test-cli`, no `http://localhost` and no wildcard in any redirect, origin, root or post-logout
URI, `sslRequired: all`, `verifyEmail: true`, the password policy, brute-force protection, no client secret
in the file, the staff OTP step REQUIRED, the customers realm with exactly the three storefront clients and
their production callbacks, the identity providers still environment placeholders. Dev behaviour is
untouched: `reimport.mjs` and the docker startup import read only the dev files in this directory (the
startup import is not recursive; `production/` is a subdirectory of the mounted import folder).

**Still needs a running cluster (#342) before these files can be imported:**

- the real hostnames in `production.config.json` (today the `<sub>.example.com` convention of infra/helm:
  `auth`, `admin`, `shop`, `shop-b`, `shop-c`), then re-derive and commit;
- SMTP (`smtpServer`, set in the admin console or by the deploy) — `verifyEmail: true`, password resets and
  the invitation mails of `inviteUser` all send mail; without it nobody can finish a first login;
- the `core-admin` client secret: Keycloak generates it at import; the operator copies it into Vault and
  the core's `KEYCLOAK_ADMIN_CLIENT_SECRET` comes from there (never the dev value);
- the identity providers: `hq-sso` / `google` stay disabled placeholders until `HQ_SSO_CLIENT_*` /
  `GOOGLE_CLIENT_*` exist in the environment of the import;
- a Postgres-backed Keycloak (`KC_DB`), TLS termination in front (`sslRequired: all`), and the first HQ
  owner created through the admin console (there are no seeded users; `inviteUser` needs an owner).

Secrets: no confidential client is defined, so no client secret is committed. Identity-provider secrets are
`${ENV_VAR:unset}` placeholders resolved by Keycloak at import time.

## How to change a realm

1. Edit the JSON (or make the change in the console, then export as below and diff).
2. Apply it to the running Keycloak without a restart, from the repo root:

   ```bash
   node infra/keycloak/reimport.mjs staff
   ```

   (deletes and re-creates the realm through the admin API; existing sessions of that realm are dropped).
   Placeholders like `${GOOGLE_CLIENT_ID:unset}` are resolved only by the startup file import; through the
   admin API they are stored literally, which is harmless for the disabled providers.

3. To prove a clean file import (placeholders included): `pnpm dev --reset` — this wipes **every** volume
   (Postgres, Redpanda too), so do it only when no other window is using the stack.
4. Run the checks: `pnpm --filter @platform/auth-sdk test` (the `keycloak-realms` tests hit the live
   server when it is reachable, and always validate the JSON files).

### Exporting a realm from the console

The admin console has no full export with users. Use the admin API partial export for everything except
users, then keep the `users` array from git:

```bash
node infra/keycloak/reimport.mjs --export staff > /tmp/staff-partial.json
```

Compare against `staff-realm.json`, copy over the section you changed (clients, flows, mappers), keep the
hand-written `users`, `identityProviders` placeholders and `attributes._comment`. Do not commit generated ids
(`id` fields on clients, flows, mappers) — the files are written id-less on purpose so imports are
deterministic, except user ids, which are the `keycloak_subject` contract with the db seed.

## Symptoms of a stale realm

`test-cli` answers `invalid_client`, or a browser login as `store-admin` demands TOTP **setup**
(`execution=CONFIGURE_TOTP` — the pre-#43 flow): the running Keycloak still holds an older realm (for
example the Phase 0 stubs imported on the volume's first start, or the REQUIRED-OTP revision). Run
`node infra/keycloak/reimport.mjs staff` / `… customers`, or `pnpm dev --reset` (wipes all volumes).

History: `KC_DB=dev-mem` dropped its in-memory database ~15 min after start (issue #37); main switched to
`dev-file` + volume, which is why the import is now one-shot.
