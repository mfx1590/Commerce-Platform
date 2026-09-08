# ADRs

Written by the main window in Phase 0. Status "accepted" means frozen with the contracts tag current at the time; changing one is an integration-period task.

| # | Title | Implemented in |
|---|---|---|
| [0001](0001-tenancy.md) | Tenancy: one database, store_id on every row, forced PostgreSQL RLS | packages/db |
| [0002](0002-auth-model.md) | Auth model: Keycloak identity, OpenFGA relationships, server-side checks | packages/auth-sdk, infra/keycloak, infra/openfga (window 2) |
| [0003](0003-outbox-events.md) | Events: transactional outbox, Redpanda, versioned JSON Schemas | packages/events, apps/core/src/outbox (window 14) |
| [0004](0004-storefront-per-brand.md) | One Next.js storefront per brand from a shared starter and UI kit | apps/storefront-starter, packages/ui (window 3), apps/storefronts/* (window 10) |
| [0005](0005-modular-monolith.md) | Modular monolith: Medusa 2 core with owned modules; split only for scaling | apps/core (window 1) |
| [0006](0006-secret-management.md) | Secrets: AWS Secrets Manager + External Secrets, environment-first paths, per-store credentials, gitleaks in CI | infra/terraform/modules/external-secrets, infra/kubernetes/external-secrets, CI (window 5) |

Format: Context → Decision (numbered) → Consequences → Alternatives rejected. New ADRs: next number, same format, PR from main/* or integration/*.
