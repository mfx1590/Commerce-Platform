# Security documentation

Phase 6 decision D4 and gate item 2 (`docs/plan/phase6-plan.md`): a threat model, a PCI SAQ-A scope note and a
SOC2-lite controls map, each control linked to a CI job or a file. Written 2026-11-10 against `origin/main` at
`b70bf183`. Owner: the main window (`docs/**` is main-window only, `docs/ownership.md`).

Nothing here is an attestation. It is a map from "what we say we do" to "where the repository proves it", plus the
list of what it does not prove.

## Index

| File | What it answers |
|---|---|
| [`threat-model.md`](threat-model.md) | Assets, actors, trust boundaries with their data flows, a STRIDE table per boundary (mitigation with evidence, residual risk, issue), and the ranked residual risks. |
| [`pci-saq-a-scope.md`](pci-saq-a-scope.md) | Why the platform is in SAQ-A scope, where the code enforces it, what would break it, which requirements still apply and what is missing. |
| [`controls-map.md`](controls-map.md) | SOC2-lite: every control, how it is enforced, its evidence (file, test, exact CI job name), its status and its owning window. |

## Vocabulary used in all three files

- **Evidence** is a path in this repository, a test file, a CI job name quoted exactly from
  `.github/workflows/ci.yml`, or an issue / PR number. A sentence is not evidence.
- **Status** of a control is one of:
  - `enforced in CI`: a job fails when the control is broken. Where the job is not a required check, the row says
    "advisory".
  - `enforced in code`: the code refuses the unsafe path and a test pins it, but the test's job decides whether a
    regression blocks a merge.
  - `documented only`: a rule or a runbook; nothing fails when it is ignored.
  - `gap`: not done. The row says what was searched for.
- **Required check** means one of the six names GitHub enforces on `main` (read from the branch-protection API on
  2026-11-10): `ownership check`, `lint + typecheck`, `unit tests (with Postgres, RLS)`, `contract tests (Prism)`,
  `secret scan (gitleaks)`, `storefront performance budget (bundle + Lighthouse)`. Every other job runs on every
  PR but does not block a merge. Re-read the list from the API before quoting it; this file is not the source of
  truth for a repository setting.

## How to keep it true

1. **A PR that changes a control updates the map in the same PR.** "Changes a control" means: it renames, moves or
   deletes a file, test or CI job named in `controls-map.md` or `threat-model.md`; it changes a limit, a role, a
   grant, a header, a redaction pattern, a retention period or an allow-list; or it closes an issue cited here as an
   open gap. A feature window cannot write `docs/`, so it names the affected row in the PR body and the manager
   edits the file on merge (or the window files `REQUEST: docs/security — <row>`).
2. **The reviewer checks it.** The review of such a PR includes: "does `docs/security/` still name real paths?".
3. **Paths are checked, not trusted.** Before each phase gate, and whenever this folder is edited, every path in
   backticks is checked with `git cat-file -e HEAD:<path>` and every job name with
   `grep -n 'name:' .github/workflows/ci.yml`. A control mapped to a file that does not exist is the defect these
   documents exist to prevent. This check is manual today (gap G-11 below).
4. **Dates expire.** `infra/security/audit-allowlist.json` entries carry `expires`; the gate fails on an expired
   entry. The launch checklist (`docs/launch-checklist.md`) holds everything that needs a cloud account, a
   third party or the owner.
5. **A new trust boundary gets a section** in `threat-model.md` before its first production secret exists (the
   rule #632 followed for service accounts).

## What is NOT done

Honest list. Each line is either a gap in the repository (with its number in `controls-map.md` / the threat
model) or an owner-only item that cannot be proven on the compose stack or in CI (plan D1).

### Gaps in the repository

| # | Gap | Evidence that it is a gap | Issue |
|---|---|---|---|
| G-1 | GitHub does not enforce a review before merge, admins are not bound by the protection, and the branch need not be up to date. The "never merge your own PR" rule is procedural. | Branch-protection API 2026-11-10: `required_pull_request_reviews` null, `enforce_admins` false, `strict` false. | no issue |
| G-2 | `live auth + end-to-end (Keycloak, OpenFGA, Playwright)` is not a required check, and it holds every live proof (real tokens, OpenFGA, money gate, PII sweep, leak property). | Same API call; `infra/README.md` "Branch protection"; plan D6. | #731 (D6) |
| G-3 | `dependency audit (production)` is advisory, and its allow-list holds a dated baseline of high/critical advisories. | `.github/workflows/ci.yml` comment on the job; `infra/security/audit-allowlist.json`. | #730 follow-up, no issue for "make it required" |
| G-4 | The storefront's `script-src` allows `'unsafe-inline'` on every page, including the page that mounts the Payment Element. | `apps/storefront-starter/src/lib/csp.ts` (the comment says "Not XSS protection"). | no issue |
| G-5 | Card payment has never run against real Stripe test keys; the live 2a gate is deferred. | #358 and #361 open; `apps/storefront-starter/e2e/card-payment.spec.ts` skips without a key. | #358, #361 |
| G-6 | Personal names are not redacted before text reaches the model; the processor question is unanswered. | `packages/ai/README.md` "Redaction: exactly what is masked"; `docs/launch-checklist.md`. | launch checklist (no issue) |
| G-7 | No alert reaches a person: no Alertmanager receiver. | `infra/observability/SLO.md` "No Alertmanager receiver is configured yet". | no issue |
| G-8 | No scheduled backup. Backups are ad-hoc dumps and the drill; the method's RPO is "since the last time someone ran it". | `infra/dr/RUNBOOK.md` "What the numbers mean"; `docs/plan/phase6-inventory.md` DR row. | launch checklist (no issue) |
| G-9 | No Kubernetes NetworkPolicy; the EKS API endpoint is public; the dev compose stack publishes most ports on all interfaces with well-known credentials. | No `NetworkPolicy` under `infra/`; `infra/terraform/modules/cluster/main.tf` (`endpoint_public_access = true`); `infra/docker/docker-compose.yml` (only ClickHouse is bound to 127.0.0.1). | no issue |
| G-10 | GitHub Actions are pinned by tag, not by commit SHA; the gitleaks image is pinned by tag. | `.github/workflows/ci.yml` (`uses: …@v4`). | no issue |
| G-11 | No CI check that the paths cited in `docs/security/` exist. | Searched `.github/workflows/` and `infra/ci/` for a docs link check: none. | no issue |
| G-12 | Rate limits cover the Store API write paths only, fail open when Redis is down, and no k6 burst script is committed. | `apps/core/src/http/rate-limit.ts`; `infra/load/k6/` holds `load.js`, `pool.js`, `ceiling.js` only. | no issue |
| G-13 | Erasure has open windows: the bus keeps identifiers up to about 31 days, the analytics ingest must stay at one replica, a never-registered guest cannot be erased from the CDP. | `docs/launch-checklist.md` "Data protection". | #629 |
| G-14 | No repository-wide guard against PII in logs; the rule is enforced per module. | Searched for a log lint or scanner: none; per-module tests listed in `controls-map.md` C-45. | no issue |

### Owner-only (launch checklist, not provable here)

- A real penetration test, and the external vulnerability scans SAQ-A asks for.
- The PCI SAQ-A self-assessment and attestation, and Stripe's own attestation of compliance on file.
- A SOC 2 audit. `controls-map.md` is the reading list for it, not a report.
- Lawyer items already on `docs/launch-checklist.md`: the Anthropic processor question (#606, #610), the erase
  decision (orders retained), bus retention after erasure (#629), the CDP tracking default.
- Cloud proofs: RDS point-in-time recovery, multi-AZ failover, KMS, Object Lock (`infra/dr/RUNBOOK.md`
  "Launch checklist").
- Production secrets, the Stripe and Anthropic accounts and their spend caps (#361).
- The branch-protection settings themselves (G-1, G-2, G-3): a repository setting only the owner can change.
