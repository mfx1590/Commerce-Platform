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
  - `admin-app` — public, authorization code + PKCE (S256), no password grant, redirect
    `http://localhost:3000/*`. Mappers put `email`, `email_verified`, `preferred_username`, `name` and
    `aud: core-api` in the access token.
  - `test-cli` — **dev/CI only.** Public client with the resource-owner password grant enabled so tests can
    mint real tokens for the seeded users (`grant_type=password&client_id=test-cli&username=…&password=…`).
    The direct-grant flow does not run the browser MFA step, which is what makes this usable in CI. Delete this
    client from any export that is not local.
- **Users** mirror `packages/db` `SEED_IDS.users`: `owner`, `finance`, `operations`, `store-admin`,
  `store-staff`, `support`, `analyst` (email `<username>@example.com`, password = username). Each user's
  Keycloak id is `seed-<username>`, which is exactly the `staff_user.keycloak_subject` the db seed writes, so the
  JWT `sub` maps to the seeded `staff_user` row without a lookup table.
- **Roles are not here.** Nothing about permissions lives in Keycloak; OpenFGA holds the relations (ADR 0002,
  `infra/openfga/model.fga`).
- Sessions: access token 15 min, SSO idle 30 min, max 10 h, refresh-token rotation on.

## Customers realm

- Self-registration (email as username), password reset, remember-me. Email verification is off locally
  (no SMTP); turn `verifyEmail` on where an SMTP server is configured.
- One public PKCE client per brand: `storefront-brand-a` (`:3100`), `storefront-brand-b` (`:3101`),
  `storefront-brand-c` (`:3102`). Each client hard-codes a `store_code` claim (`brand-a` …) and `aud: core-api`
  so the core can bind a customer token to one store (ADR 0002 §8).
- `test-cli` (dev/CI only) as above.
- Social login: `google` identity provider present but **disabled**; its client id/secret come from the
  environment (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`) via realm-import placeholders. Enable it by setting
  the variables and flipping `enabled` to `true`.
- Seed user: `jane@example.com` / `jane` (id `seed-jane`).

## Dev-only settings (must change outside local)

| Setting                                | Local value                | Elsewhere                               |
| -------------------------------------- | -------------------------- | --------------------------------------- |
| `sslRequired`                          | `external`                 | `all` behind TLS                        |
| OTP step in `browser-mfa forms` (#43)  | CONDITIONAL                | REQUIRED (forced enrolment)             |
| `owner` pre-enrolled TOTP credential   | documented secret above    | remove; no committed OTP secrets        |
| Seeded users with password = username  | present                    | remove the `users` array                |
| `test-cli` client (password grant)     | present                    | remove                                  |
| Password policy                        | none (seed passwords)      | e.g. `length(12) and notUsername and …` |
| `verifyEmail` (customers)              | `false`                    | `true` with SMTP configured             |
| `attributes.frontendUrl`               | `http://localhost:8180`    | the public Keycloak URL                 |
| Redirect URIs / web origins            | `http://localhost:*`       | the real app origins                    |
| `hq-sso` / `google` identity providers | disabled placeholders      | real client ids from the environment    |
| Keycloak `KC_DB=dev-file` + volume     | one-shot import, persisted | Postgres                                |

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
