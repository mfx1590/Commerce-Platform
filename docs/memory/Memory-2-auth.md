# Memory 2 — Auth & RBAC

Window: 2 · Key: `auth` · Branch prefix: `auth/` · Model: Sonnet (strongest for the OpenFGA model)
Last updated: 2026-09-04 · Contracts: (not tagged yet) · Last commit: (none) · Status: not started

## Identity (does not change)

Owned paths (write):

- `packages/auth-sdk/**`
- `infra/keycloak/**`
- `infra/openfga/**`
- `apps/core/src/modules/hq-rbac/**`
  Reads:
- packages/contracts
- docs/adr/auth.md
  Never touches:
- apps/admin UI
- apps/storefront*

## Mission — Phase 1 (Isolated modules)

Keycloak realms (staff with MFA + SSO, customers per brand), OpenFGA authorization model, tuple management API, scope-resolution middleware (JWT → allowed store_ids + permissions), append-only audit log, and packages/auth-sdk exposing can(user, action, resource) and allowedStores(user). Prove a store_admin of two stores gets 403 on every finance route.

## Done

- (nothing yet)

## In progress

- (nothing yet)

## Next — Phase 1

- [ ] Keycloak realm export files: staff (MFA, OIDC) and customers
- [ ] OpenFGA model: organization{owner,finance,operations,analyst}, store{store_admin,store_staff,support}
- [ ] Tuple management API + CLI (assign/revoke store to user)
- [ ] Scope middleware in hq-rbac: JWT → {allowedStores, permissions}
- [ ] Audit log table + writer; append-only, includes before/after
- [ ] packages/auth-sdk: can(), allowedStores(), typed permissions
- [ ] Tests: 2-store admin → 403 on /admin/finance/*; analyst cannot export PII

## Decisions made (with reasons)

- (none yet)

## Blocked / waiting

- (none)

## Gotchas learned

- (none yet)

## How to run & test this package

- (fill in after first setup: exact commands)

## Later phases (do not start until Memory-main says so)

### Phase 3 — Multi-store & HQ

Role management UI support: APIs for listing users, assigning stores, finance gate; SSO for HQ.

- [ ] Role admin endpoints
- [ ] SSO config
- [ ] Session revocation on role change
