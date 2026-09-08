# ADR 0006 — Secret management: AWS Secrets Manager, External Secrets Operator, environment-first paths, per-store credentials

Status: accepted (Phase 2, 2026-09-08, from REQUEST #155) · Owner: main window (this decision), window 5 (implementation) · Implemented in `infra/terraform/modules/external-secrets`, `infra/kubernetes/external-secrets`, `infra/helm` (values `externalSecrets.remoteKeys`), `infra/gitleaks.toml`, CI job `secret scan (gitleaks)`

## Context

Every app needs credentials (database roles, Redis, session secrets, per-store PSP and carrier keys) in dev and
staging, and later in production. The fixed decisions are managed-first hosting (docs/decisions.md #5) and "secrets
come from env/Vault, never committed" (root CLAUDE.md). Two things must hold structurally, not by discipline: a
value never exists in git, a values file, a chart or a terminal; and one environment (or one store) can never read
another's credentials. Window 5 implemented the scheme in task 2.6 (#36) and asked for the decision to be recorded.

## Decision

1. **Source of truth is AWS Secrets Manager.** Terraform creates and rotates platform secrets; per-store
   third-party credentials are created by an operator with the CLI (`infra/README.md` → Secrets). No Vault: Secrets
   Manager is already there, IAM already governs it, rotation is an API call, and there is no extra stateful service
   to run, unseal and back up. The charts name a *key*, not a backend, so a later phase can swap the backend without
   touching them.
2. **Delivery path:** Terraform → Secrets Manager → External Secrets Operator (cluster-scoped `ClusterSecretStore`,
   applied at bootstrap) → Kubernetes `Secret` → `envFrom` in the pod. Apps read environment variables only; nothing
   in the app layer knows the backend.
3. **Environment-first paths.** `<env>/platform/<component>` for platform-wide secrets (one per environment) and
   `<env>/stores/<store_code>/<provider>` for anything a store owns. `<env>` is the first segment because it is the
   one boundary that must never be crossed: the External Secrets role for `staging` is granted `staging/*` as an IAM
   *prefix* and is structurally unable to read `dev/*`. Consequence accepted: a secret shared across environments is
   duplicated per environment.
4. **Per-store, not per-platform, for what a store owns.** PSP and carrier keys belong to a legal entity (one per
   brand, decisions.md #7); brand B's refund must not be able to use brand A's key. Scoping is done by which
   `ExternalSecret` a chart declares, not by the role, so onboarding a store needs no Terraform run. Consequence
   accepted: more secrets to rotate.
5. **`<store_code>` (`brand-a`), not the store UUID, in the path.** A human granting or revoking access must be
   able to read the path and know what it is. Consequence accepted: renaming a store code orphans its secrets
   (store codes are stable by contract; a rename is an onboarding-workflow task with a migration step).
6. **The operator role is read-only and scoped to one environment's two prefixes.** An operator that can write can
   silently replace a credential nobody chose; writes stay with Terraform and a human with the CLI.
7. **Secret scanning is part of the definition of green.** `gitleaks` runs in CI over the tree *and the history* on
   every change, with no path filter, as a CLI in a container without `pull-requests: write` (a PR comment quoting a
   finding would republish the leaked value). `infra/gitleaks.toml` only adds allowlists, each with a reason, and
   anchors them on the extracted secret. Local well-known dev values from `.env.example` are allowlisted by name so a
   *new* secret-shaped string still fails.

## Consequences

- Windows 7 (payments) and 8 (shipping) read per-store credentials from environment variables named by their
  chart's `externalSecrets.remoteKeys`; locally from `.env`. They never call Secrets Manager directly and never log
  a value.
- A new environment = a new prefix, a new role, a duplicated set of platform secrets. A new store = new
  `<env>/stores/<code>/…` entries and `remoteKeys` lines in that brand's values; no IAM change.
- Rotation: write the new value in Secrets Manager, External Secrets syncs, Reloader restarts the deployment
  (2.4b). Roll-back is the same path with the previous value.
- Local development keeps `.env` (copied from `.env.example`); production values never appear there.

## Alternatives rejected

- **HashiCorp Vault** — the plan's original word. Another stateful service to run, unseal, back up and upgrade
  before there is anyone to run it; revisit if a multi-cloud or dynamic-database-credential need appears (Phase 6).
- **Sealed Secrets / SOPS in git** — encrypted values in the repository still put the value's lifecycle in git
  history and make rotation a commit; rejected for the same reason as committed values.
- **Store UUID in the path** — stable under renames but unreadable by the human doing access reviews.
- **Environment last (`platform/<component>/<env>`)** — makes the IAM resource a pattern (`platform/*/dev`), which
  is easy to get wrong and impossible to express as a plain prefix.
