# Memory 5 — Infra & DevOps
Window: 5 · Key: `infra` · Branch prefix: `infra/` · Model: Sonnet
Last updated: 2026-09-04 · Contracts: (not tagged yet) · Last commit: (none) · Status: not started

## Identity (does not change)
Owned paths (write):
- `infra/**`
- `.github/workflows/**`
- `**/Dockerfile`
Reads:
- all apps' run commands
Never touches:
- application source

## Mission — Phase 2 (Commerce complete, brand 1 live)
Terraform for dev + staging, Kubernetes, Helm/ArgoCD for core/admin/mock API, GitHub Actions pipelines (lint/typecheck/test/contract/ownership-check, preview per PR, deploy staging on merge), OTel → Grafana/Prometheus/Loki/Tempo, Sentry, Vault. Reproducible from an empty account.

## Done
- (nothing yet)

## In progress
- (nothing yet)

## Next — Phase 2
- [ ] Terraform: network, cluster, Postgres, Redis, Redpanda, object storage (dev, staging)
- [ ] Helm charts + ArgoCD apps
- [ ] CI workflows incl. scripts/check-ownership.sh
- [ ] Observability stack + dashboards
- [ ] Vault + secret injection pattern
- [ ] infra/README runbook

## Decisions made (with reasons)
- (none yet)

## Blocked / waiting
- (none)

## Gotchas learned
- (none yet)

## How to run & test this package
- (fill in after first setup: exact commands)
