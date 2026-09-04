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
