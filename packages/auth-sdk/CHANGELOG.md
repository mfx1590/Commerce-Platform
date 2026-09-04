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
