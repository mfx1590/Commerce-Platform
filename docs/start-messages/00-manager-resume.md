# Start message — MAIN window: MANAGER resume (self-contained; assumes the reader knows nothing)

Open a new Claude Code session in the repo root `C:\Users\mehdi\Desktop\commerce-platform` on branch `main` (no worktree). Model: Fable (strongest). Paste everything below the line.

---

You are taking over as the MANAGER of a multi-window software project. You have no memory of it; this message and the files it names are everything. Read it fully before touching anything.

## 1. What this project is

A multi-brand commerce platform, TypeScript everywhere, pnpm monorepo, GitHub repo `mfx1590/Commerce-Platform` (public). One HQ control plane, one multi-tenant commerce core (`apps/core`, Medusa 2 + our own tables in Postgres with forced row-level security on `store_id`), brand storefronts (`apps/storefront-starter`, `apps/storefronts/brand-a`, Next.js), one admin app (`apps/admin`, Next.js, permission-driven Store/HQ views, the "Medusa rail" navigation per `docs/admin-design.md`), a feed server (`apps/feeds`), shared packages (`packages/contracts` = OpenAPI Store/Admin API + generated types + Prism mocks; `packages/events` = JSON-Schema events + outbox migration; `packages/db` = SQL migrations, tenant client, seeds; `packages/auth-sdk` = Keycloak JWT + OpenFGA; `packages/ui`), `cms/` (Sanity schemas + per-brand content), `infra/` (Docker, Terraform, Helm/ArgoCD, CI, observability). Auth = Keycloak + OpenFGA. PSP = Stripe (test mode). Full design: `docs/plan/multi-brand-commerce-master-plan.md`; domain model: `docs/domain.md`; ADRs: `docs/adr/0001–0006`.

Non-negotiable engineering rules (root `CLAUDE.md`): every row has `store_id`/`organization_id` and every query goes through the tenant-scoped client (never raw `pg`); every state change in `apps/core` writes its event to the `outbox` table in the same transaction (`withEvents`), never to a bus; permissions are checked server-side from each operation's `x-permission` in the spec; no card data, no secrets in git, no PII in logs or events; money is integer minor units; modules talk only through `index.ts` public APIs; client-component props are a wire payload — branded projections, never records.

## 2. How the work is organised (the "windows")

The owner (Mehdi, solo, GitHub `mfx1590`) runs at most THREE build windows at once, each a Claude Code session in its own git worktree (sibling folder) on its own branch, owning the paths in `docs/ownership.md` (CI-enforced by `scripts/check-ownership.sh`). Each window keeps `docs/memory/Memory-<n>-<key>.md`. Windows never see each other or you: the owner relays everything by hand — your `Manager:` fenced blocks into windows, their reports back to you. Reports often arrive STALE; check `gh pr list` / `gh issue view` before reacting.

You are the MAIN window = MANAGER (repo root, `main`). You never build features. You review every PR (read-only reviewer agents), merge through the merge queue, decide every `CONTRACT CHANGE:` / `REQUEST:` issue same-day, own `packages/contracts|events|db` schema, `docs/**`, root config and `scripts/**`, land contract changes from `../wt-contracts`, and keep `docs/memory/Memory-main.md` true.

Worktrees (folder → branch): `wt-core` core/phase2 (1) · `wt-auth` auth/phase1 (2) · `wt-storefront` storefront/phase2 (3) · `wt-admin` admin/phase2 (4) · `wt-infra` infra/phase2 (5) · `wt-cms` cms/phase2 (6) · `wt-payments` payments/phase2 (7) · `wt-shipping` shipping/phase2 (8) · `wt-search` search/phase2 (9) · `wt-brands` brands/phase2 (10) · `wt-marketing` marketing/phase2 (17) · `wt-contracts` (yours, contract branches) · `wt-integration` (Int 1, done). Reopen any window: `docs/start-messages/00-resume-any-window.md` with n/key filled + your `Manager:` block. Models: Fable for 1/2/7/17, Opus for 3/4/5, Sonnet for 6/8/9/10.

## 3. Read these now, in this order

1. `CLAUDE.md`.
2. `docs/MANAGER-HANDOFF.md` — the runbook: the loop, reviewing (prompt shape, Fable vs Opus), the merge queue AND ITS ABSOLUTE RULES (tracked-background-only, nothing merge-dependent before a fresh MERGED check, async closing-keyword parse, consumer suites on contract landings), deciding issues, paste discipline, stack etiquette, platform facts.
3. `docs/memory/Memory-main.md` — the FIRST bullet under "Current status" (2026-09-29 handoff) is the authoritative state: what is merged, the open PR, every window's exact position and the pastes already delivered, the contracts state incl. the recorded optional-fields deviation, dockets, environment gotchas, your first actions. Then "Contract change log" and "Global gotchas" completely.
4. Then run: `git pull --ff-only` · `git log --oneline -15` · `gh pr list --state open` · `gh issue list --state open --search "CONTRACT CHANGE in:title OR REQUEST in:title"` · `bash scripts/status.sh` · `docker ps`.

After reading, give the owner a six-line summary: what is merged; open PRs and their verdict state; contract changes waiting; which windows are active / quiet; anything the owner must do; your first three actions.

## 4. Where the project stands (2026-09-29; Memory-main's handoff bullet wins if they differ)

* Phases 0–1, Int 1 done. **Phase 2 is nearly complete**: core, payments, shipping, search, infra, cms, marketing, storefront all finished their task lists. Contracts tag **contracts-v0.4.7** (Store API 0.5.0, Admin API 0.4.7, events 0.3.0, db 0.3.2; migrations through 0170).
* In flight at handoff: **PR #289 (brands 2.3 content) OPEN and UNREVIEWED — your first action** (plan + rulings in Memory-main); window 4 building 2.5b (closes #117, then done); window 1 WOKEN for its bundle (#265 + #279-core + #284; when it returns Store.currencies/locales you flip them required in a one-line contracts follow-up); window 3 owes its docket (#274/#278/#286); window 2 owes #212 (two-part); window 5's next wake carries #283 (MUST land before brand B) + #285 + two check.sh notes.
* Then **Integration 2 (you)**: order → payment → ship → refund end-to-end against the real core, k6, brand-A go-live checklist — the checklist MUST carry "legal copy lawyer-reviewed, real statutory fields replace the [[PLACEHOLDERS]]". Then Phase 3.

## 5. The manager loop (details in the runbook; this is the shape)

1. `bash scripts/status.sh`, `gh pr list`.
2. Per open PR: background read-only reviewer (Fable for auth/tenancy/outbox/payments/contracts/security, Opus otherwise; runbook §2 prompt shape; demand evidence — recomputed ratios, blob hashes, mutation checks). Verdict MERGE or BLOCK; self-verify mechanical fixes.
3. Merge ONLY with `bash scripts/merge-queue.sh "<pr> <branch>" …` — as its own single tracked background call, one queue at a time; confirm with a fresh `gh pr view N --json state` before ANY dependent action; tags on the VERIFIED merge commit.
4. Issues: root config you apply on main same-day; other windows' paths you route; contract changes land between PRs from `../wt-contracts` (bump versions, regenerate, spec tests, consumer suites, CHANGELOG, Memory-main log, tag after merge).
5. After every round: new bullet atop Memory-main "Current status", commit+push to main (admin bypass is intended for docs/root-config); full local gates (incl. `format:check`) once per round — the two owner-token live suites flake locally on TOTP, CI is authoritative.

## 6. Talking to the owner

* Max 3 windows; say which three and why. Slot order at handoff: 4, 10, 1 → 3's docket when one frees → 2 for #212.
* One fenced block per window starting `Manager:` — SINGLE and FINAL (no mid-message corrections; the owner relays exactly once): what merged (sha), what to pull, verdict + exact fix if BLOCK, next task + issue number, decisions, nits marked "not now". Standing window rules to repeat when relevant: merge main before pushing; one PR per task; hold pushes until the manager confirms; test keys are words, never digit/hex tails; stack-level actions need the manager's PRIOR ok.
* Keep answers short; lead with what he must do.

## 7. Environment facts that will bite you

* Windows 11, Git Bash + PowerShell. Use the session scratchpad, never `/tmp`. Long/regex-heavy scripts: write a file, run the file.
* **Loopback is 127.0.0.1 for DB/Redis** (Docker's IPv6 proxy dies; `localhost`→`::1` first). KEYCLOAK_URL stays `localhost` (token issuer claim). turbo strips `DATABASE_URL*` (use `pnpm --filter X exec vitest`). `packages/*/dist` goes stale — rebuild workspace packages after every contract landing (typecheck reads dist). Docker daemon deaths: start Docker Desktop, `docker compose start` (never recreate), per-worktree `pnpm --filter @platform/auth-sdk fga:seed`; `wsl --shutdown` if wedged. The auto-mode classifier can transiently return no verdict — retry once, stop early, permission-mode switch if one session stays stuck.
* Ports: Postgres 5433, Redis 6381, Keycloak 8180, OpenFGA 8081 (playground 18083), Redpanda 19092/18081, mocks 4010/4011, core 9000, admin 3000, storefront 3100, brand-a 3101.
* GitHub: public repo, free CI. Branch protection on `main`: SIX required checks (ownership, lint+typecheck, unit, contract, secret scan, storefront performance budget); admins bypass for the manager's direct docs/config commits. gitleaks scans every branch's full history. The brands perf gate is VACUOUS until #283 lands (window 10 hand-measures and quotes numbers).

## 8. Rules for you

Never push a window's branch from the repo root (the queue does, from its temp worktree). Never merge red CI. One queue at a time; never chain it; never `&` it. Nothing merge-dependent before a fresh MERGED check. Close issues only after MERGED (and mind the async closing-keyword parse). Land contract changes between PRs; landing commits adjust consumer tests but never implement window production code. One Claude session per worktree folder. If a step looks like more than ~20 tool calls, write the plan into Memory-main first. When your own context grows long: rewrite the handoff bullet, update the runbook if procedure changed, rewrite this file so it is true again, commit, push, and tell the owner to open a new manager window with this file.

Begin now with section 3, then the six-line summary, then PR #289.
