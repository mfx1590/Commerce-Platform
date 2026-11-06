# Phase 6 — Scale and hardening: the plan (manager session eleven, 2026-11-06)

Tracking issue: #731 (label `phase:6`); wave 1: #729, #730, #728, #620, #497.

Source: master plan §5 "Phase 6" (k6 load and SLOs, security audit, PCI/SOC2, DR drills and backups, splitting hot
services, cost, onboarding a brand every few days). Input: `docs/plan/phase6-inventory.md` (what exists on main,
what is missing, owners). This file adapts it to one laptop, no cloud accounts yet, Max 5x, and at most three build
windows at a time. Decisions are final unless the owner overrides.

## 1. Decisions (and why)

| # | Decision | Why |
|---|---|---|
| D1 | **Phase 6 makes the platform safe to launch, on the laptop, before any cloud account exists.** Every task here must be provable on the compose stack or in CI. Cloud-only proofs (RDS PITR, a real pentest, PCI attestation) go to the launch checklist with the exact procedure. | The owner's accounts and keys are the launch blocker, not the code. Work that needs them now would produce artefacts nobody can run (the #342 rule). |
| D2 | **No service split in Phase 6.** Search/recommendations, reporting/ask and the relay CLI stay in the core. A split happens only when a measurement says so (a k6 knee below the target, or a deploy coupling that bites). | The 10-06 load report has the core far under its 500 ms target (p95 7–76 ms). Splitting adds a deploy unit, a network hop and a failure mode for no measured gain. ADR 0005 §5/§7 stay the criteria. |
| D3 | **Observability first: the core exports OpenTelemetry, and SLOs are written as Prometheus rules checked in CI.** No Sentry or paid APM. | The Grafana dashboard exists but is empty for the core. Without core metrics, neither load tests nor SLOs can be judged in production. Rules in git and checked by promtool cost nothing. |
| D4 | **Security baseline as code:** dependency scanning in CI (fails on a known-vulnerable production dependency), security headers on the admin, rate limits on the core's public write paths, and a threat model + PCI SAQ-A scope note + SOC2-lite controls map in `docs/security/`, each control linked to a CI job or a file. | Hosted fields keep us at SAQ-A, so the PCI work is scoping, not engineering. The controls map makes the audit a reading exercise later. |
| D5 | **DR is a drill, not a document:** a script backs up Postgres, ClickHouse and the OpenFGA/Keycloak state, restores into a FRESH stack, checks it, and records the time (RTO) and the data window (RPO). | No restore has ever been done. A backup nobody has restored is a guess. |
| D6 | **`live auth + end-to-end` becomes a REQUIRED check** once it has 10 consecutive green runs on main, and the infra README stops claiming it already is. The branch-protection change is the owner's (a repo setting). | Every live gate proof (money, ingest, PII, leak, metrics p95) sits in that job, and the queue currently merges before it finishes. |
| D7 | **The cloud target is decided with the owner in wave 2, from a cost model.** The model compares managed-first (decisions.md #5: Vercel, Neon, Upstash, Redpanda Cloud) with the existing Terraform (EKS/RDS) per environment, plus AI spend per store. | It is money and the owner's call. Terraform and decisions.md disagree today; nothing deploys until that is settled. #497 is fixed in wave 1 either way, since it blocks ANY managed Postgres. |
| D8 | **Brand onboarding is proven by doing it:** onboard a non-seeded brand D end to end through the wizard and `new-brand.mjs`, timed, and every manual step left becomes an issue. | "A brand every few days" is the master plan's goal, and it has never been tried outside the seed. |

## 2. Waves (at most three build windows; one machine holder)

**Wave 1 (starts 2026-11-06):**
- 1 — core OpenTelemetry (traces + RED metrics per route and store, exported to the compose collector; Grafana shows per-store rate and p95 during a k6 run).
- 5 — dependency scanning job + `docs/slo.md` + Prometheus alert rules validated by promtool in the observability job; fix the infra README's required-checks claim.
- 10 — #728, the brands re-sync for the #609 rails.
- 3 — #620 (a small flake fix), alongside.
- Manager — #497 (backfills without BYPASSRLS), on an integration branch, Fable review.

**Wave 2:**
- 5 — the backup/restore drill + runbook (D5).
- 1 — rate limits on the Store API login/cart/checkout paths, 429 + Retry-After (D4), and the pool-connection knee from the load report.
- 4 — admin security headers (D4).
- Manager — `docs/security/` (D4), the cost model (D7, with the owner), and D6 once the 10 green runs exist.

**Wave 3:**
- 10 + 4 + 5 — brand D onboarding (D8), with #439, #647 and an engagement Dockerfile/image (5).
- A scheduled k6 regression (5) against the SLOs.

## 3. Phase 6 gate (measurable)

1. **Observe:** a k6 run shows core rate, error rate and p95 per route and store in Grafana. Every SLO has a Prometheus rule that promtool validates in CI.
2. **Secure:** dependency scanning fails on a seeded vulnerable dependency. Admin headers are pinned by tests. A k6 burst on login/cart/checkout gets 429 + Retry-After. `docs/security/` maps every control to evidence.
3. **Recover:** the drill restores a fresh stack from backups, checks it, and records RTO and RPO. A second run by a different window gets the same result.
4. **Merge safely:** `live auth + end-to-end` is required, after 10 green main runs.
5. **Onboard:** brand D goes live on the dev stack through the wizard and `new-brand.mjs`, timed, with every manual step an issue.
6. **Deploy-ready:** #497 fixed; helm renders every service and brand; the cloud target is decided with the owner (D7).

## 4. Deferred, with reasons

Service split (D2) · a real pentest, PCI attestation and SOC2 audit (owner, launch) · RDS PITR and multi-AZ proofs
(cloud accounts) · Sentry/APM (D3) · #611's later wave.
