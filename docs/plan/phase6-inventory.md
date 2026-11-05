# Phase 6 — inventory before planning (manager session eleven, 2026-11-05)

Input for the Phase 6 plan ("Scale and hardening", master plan §5). A read-only survey of main on 2026-11-05.
Not a plan yet: the manager writes `docs/plan/phase6-plan.md` from this. Paths and owners per docs/ownership.md.

## What exists, what is missing

| Theme | Exists | Missing | Without accounts? | Owner |
|---|---|---|---|---|
| Load + SLOs | k6 suite in `infra/load/` (load, pool, ceiling; manual `load.yml`); report `infra/load/reports/2026-10-06.md` (p95 7–76 ms vs 500 ms target; knee 200–400 rps from 4 pool connections per `GET /store`; the store-row lock); the storefront perf gate (required); metrics p95 step (#722); `infra/observability/` (Prometheus, Loki, Tempo, OTel collector, Grafana platform-overview) | OpenTelemetry in the core (only analytics-ingest exports, so the dashboard is empty); written SLOs; alert rules / Alertmanager; a scheduled load regression; admin and worker load scripts | yes | 5 (infra), 1 (core instrumentation) |
| Security | gitleaks (required); ADR 0006 secrets; CSP per storefront; Stripe hosted fields; AI rate limit + budget; the Fable re-review list complete | dependency scanning (dependabot / pnpm audit / osv / CodeQL); admin security headers; rate limiting on the core Store/Admin APIs; a threat model, PCI SAQ-A scope note, SOC2-lite controls map; services still bound on all interfaces | yes (a real pentest / attestation needs the owner) | 5 (CI), 4 (admin headers), 1 (rate limits), main (docs) |
| DR + backups | ad-hoc `pg_dump -Fc` before migrations (`commerce-platform-backups`, 22+ dumps); Terraform dev/staging with RDS retention + deletion protection; Keycloak realm JSON; OpenFGA model in git; topic policy as code | a restore has never been done; no runbook, RPO or RTO; no ClickHouse backup; compose OpenFGA is in-memory; no prod Terraform env; Terraform (EKS/RDS) vs decisions.md #5 (managed-first) unresolved; #497 blocks any cloud DB | yes for scripts, runbook and a local drill; no for RDS PITR | 5, main (#497) |
| Service split | separate images: core, admin, starter, accounting, analytics-ingest, notifications, feeds, brands a/b/c; ADR 0005 §5/§7 split criteria | no engagement Dockerfile/image; helm/ArgoCD only for core, admin, storefront, mocks (#439); helm `strategy` (#647); search/recommendations, reporting/ask and the relay CLI still in the core. No measurement says a split is needed yet | yes | 5; split code 9, 12, 14 |
| Cost | Actions free (public repo); images only on Dockerfile changes; single-NAT dev; AI per-store/org budgets | a cloud cost model (managed-first vs EKS/NAT/RDS); a per-store AI spend report | yes (docs) | main, 5, 14 |
| Brand onboarding | admin wizard (#428); `apps/storefronts/brand-b/scripts/new-brand.mjs` + sync; `ONBOARDING-GAPS.md`; per-brand LAUNCH.md | names/legal prose; Keycloak client + Sanity dataset (#528, #527); Dockerfile/bake/helm per brand (#439); a non-seeded brand never onboarded end to end, never timed | yes except domains, Sanity, Vercel | 10, 4, 5 |

Also: the CI job `live auth + end-to-end` is NOT a required check (required: ownership, lint + typecheck, unit, contract, secret scan, storefront perf), while `infra/README.md` (~line 734) says it is. The doc and the setting disagree.

## Candidate Phase 6 tasks buildable now (survey's ranking; the manager decides)

1. Make `live auth + end-to-end` required (fix #620 first; 10 green main runs) — 5 + the owner's repo setting.
2. #497: backfills that work without BYPASSRLS (0190, 0191, 0194 under a non-bypass migration role in CI) — main.
3. Dependency scanning job that fails on a seeded vulnerable dependency — 5.
4. OpenTelemetry in the core: Grafana shows per-store rate and p95 during a k6 run — 1 (+5).
5. SLOs (`docs/slo.md`) + Prometheus alert rules validated by promtool in the observability job — 5.
6. Backup + restore drill script and runbook (Postgres, ClickHouse, OpenFGA state; restore into a fresh stack; checksums; timed RTO) — 5.
7. #647, #439 and an engagement Dockerfile: helm renders every worker and brand — 5.
8. Admin security headers + core Store API rate limiting (login, cart, checkout; 429 + Retry-After under a k6 burst) — 4, 1.
9. Threat model + PCI SAQ-A scope note + SOC2-lite controls map under `docs/security/` — main.
10. Onboard a non-seeded brand D through the wizard and new-brand.mjs, timed, every manual step an issue — 10.
11. Cost model doc; resolve the decisions.md #5 conflict — main.
12. The pool-connection bottleneck (knee above 400 rps on the k6 pool ramp) — 1.
