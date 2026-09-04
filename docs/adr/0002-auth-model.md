# ADR 0002 — Auth model: Keycloak for identity, OpenFGA relationships for authorization, checked server-side

Status: accepted (Phase 0, 2026-09-04) · Owner: main window · Implemented by window 2 in `packages/auth-sdk`, `infra/keycloak`, `infra/openfga`

## Context

The admin app is one application with two views. Which sections render depends on what the user may do; a store
admin of N stores sees those stores and never Finance. Role names hard-coded in the application cannot express
"admin of exactly these stores" and drift from the database. Customers are a separate population per brand.

## Decision

1. **Keycloak, two realms.** `staff` (HQ + store admins; SSO, MFA required) and `customers` (per-brand clients,
   social login, passwordless). The JWT `sub` is mirrored into `staff_user.keycloak_subject` /
   `customer.keycloak_subject`; nothing else about roles lives in Keycloak.
2. **OpenFGA holds relationships, not role names in code.** Authorization model (frozen names, `infra/openfga/model.fga`):

   ```
   type user
   type organization
     relations
       define owner: [user]
       define finance: [user] or owner
       define operations: [user] or owner
       define analyst: [user] or owner
       define support: [user] or owner
       define viewer: owner or finance or operations or analyst or support
   type store
     relations
       define organization: [organization]
       define store_admin: [user] or owner from organization
       define store_staff: [user] or store_admin
       define support: [user] or support from organization or store_admin
       define analyst: analyst from organization
       define viewer: store_staff or support or analyst or operations from organization or finance from organization
   ```
   Tuples: `user:ali store_admin store:brand-a`, `user:maryam finance organization:hq`, every `store organization organization:hq`.
3. **Every mutating route re-checks** with `requirePermission(relation, object)` from `@platform/auth-sdk`; the
   relation and object for each operation are written in the OpenAPI as `x-permission` (packages/contracts) so
   the UI, the server and the reviewer read the same source. `viewer` means "any relation on the object".
4. **Scope resolution feeds tenancy (ADR 0001).** `resolveScope(principal)` lists the stores where the user has any
   relation (`ListObjects store viewer`) and whether they hold an organization-level relation. That becomes
   `app.store_ids` / `app.scope`.
5. **Finance is organization-only by construction.** Accounting and the ledger require `finance` on
   `organization:hq`. No store relation implies it, however many stores a person manages.
6. **Limits inside a relation are data, not new relations.** Example: `support` may refund up to
   `store.settings.support_refund_limit_minor`; the route checks the amount after the relation.
7. **Audit.** Every admin mutation writes `audit_log` (actor, action, store, before/after) in the same transaction
   (helper in `@platform/auth-sdk`). Role changes are written to OpenFGA first, then mirrored to `role_assignment`
   for listing, then audited.
8. **Customers never touch OpenFGA.** Customer routes derive the customer from the JWT `sub` + store; RLS does the
   rest.

## Consequences

- Adding a role = adding a relation to the model + a tuple type; no code deploy for assigning it to a user.
- The `Relation` enum in packages/contracts and `role_assignment.relation` CHECK constraint must match the model;
  window 2 owns the model file, main window owns the two mirrors (CONTRACT CHANGE to add a relation).
- UI gating reads `GET /admin/me` (relations per store); it is a convenience only.
- OpenFGA is a runtime dependency of every admin request; window 2 adds a short in-process cache and a fail-closed
  policy (OpenFGA down → 503, never allow).

## Alternatives rejected

- **Keycloak roles/groups only**: cannot express per-store assignment cleanly; role explosion (`brand-a-admin`, …).
- **Casbin in-process**: policies in files, no shared truth across services and BI row-level filters.
- **Auth0 / Zitadel**: acceptable, but self-hosted Keycloak matches managed-first budget and the plan's default.
