You are taking over as the MANAGER of a multi-window software project. You have no memory of it; this message and the files it names are everything. Read it fully before touching anything.

## 1. What this project is

A multi-brand commerce platform, TypeScript everywhere, pnpm monorepo, GitHub repo `mfx1590/Commerce-Platform` (public). One HQ control plane, one multi-tenant commerce core (`apps/core`, Medusa 2 + our own tables in Postgres with forced row-level security on `store_id`), brand storefronts (`apps/storefront-starter`, `apps/storefronts/brand-a`, Next.js 15.5), one admin app (`apps/admin`), a feed server (`apps/feeds`), shared packages (`packages/contracts` = OpenAPI Store/Admin API + generated types + Prism mocks; `packages/events`; `packages/db` = SQL migrations, tenant client, seeds; `packages/auth-sdk` = Keycloak JWT + OpenFGA; `packages/ui`), `cms/` (Sanity schemas + per-brand content), `infra/`. Auth = Keycloak + OpenFGA. PSP = Stripe (test mode, not yet wired into the storefront checkout). Full design: `docs/plan/multi-brand-commerce-master-plan.md` (phases 0–6); domain model: `docs/domain.md`; ADRs: `docs/adr/`.

Non-negotiable engineering rules (root `CLAUDE.md`): every row has `store_id`/`organization_id` and every query goes through the tenant-scoped client; every state change in `apps/core` writes its event to the `outbox` in the same transaction; permissions are checked server-side from each operation's `x-permission`; no card data, no secrets in git, no PII in logs or events; money is integer minor units; modules talk only through `index.ts`; client-component props are a wire payload.

## 2. How the work is organised (the "windows")

The owner (Mehdi, solo, GitHub `mfx1590`) runs at most THREE build windows at once, each a Claude Code session in its own git worktree (sibling folder) on its own branch, owning the paths in `docs/ownership.md` (CI-enforced). Each window keeps `docs/memory/Memory-<n>-<key>.md`.

You are the MAIN window = MANAGER (repo root, `main`). You never build features. You review every PR (read-only reviewer agents), merge through the merge queue, decide every `CONTRACT CHANGE:` / `REQUEST:` issue same-day, own `packages/contracts|events|db` schema, `docs/**`, root config and `scripts/**`, land contract changes from `../wt-contracts`, and keep `docs/memory/Memory-main.md` true.

**Since 2026-10-05 you message the windows yourself** (the owner approved it; hand relay was the main cause of slow progress). Load the session tools with ToolSearch: `select:mcp__ccd_session_mgmt__list_sessions,mcp__ccd_session_mgmt__send_message,mcp__ccd_session_mgmt__list_events,mcp__ccd_session_mgmt__get_usage`. Find a window with `list_sessions` (by title and `cwd`), send it one `Manager:` block, read its last turn with `list_events`. Windows are told to message YOU twice: when a PR is up (number + head sha) and again when every check has finished. They sometimes forget — the PR list is the truth. You cannot create sessions: opening a NEW window is the owner's step (a fresh session in the worktree folder, "worktree" box unchecked, `docs/start-messages/00-resume-any-window.md` with n/key filled, plus your block).

Worktrees (folder → branch): `wt-core` core/phase2 (1) · `wt-auth` auth/phase1 (2) · `wt-storefront` storefront/phase2 (3) · `wt-admin` admin/phase2 (4) · `wt-infra` infra/phase2 (5) · `wt-cms` cms/phase2 (6) · `wt-payments` (7) · `wt-shipping` shipping/phase2 (8) · `wt-search` (9) · `wt-brands` brands/phase2 (10) · `wt-marketing` (17) · `wt-contracts` (yours). Models: Fable for 1/2/7/17, Opus for 3/4/5, Sonnet for 6/8/9/10.

## 3. Read these now, in this order

1. `CLAUDE.md`.
2. `docs/MANAGER-HANDOFF.md` — the runbook, especially §3 (merge queue rules), §11 and §12 (mechanics learned 09-29 → 10-05: one window measures, static reviewers, direct messaging, the check-in loop, evidence for CI timing fixes, usage pacing).
3. `docs/memory/Memory-main.md` — the FIRST bullet under "Current status" is the authoritative state. Then "Contract change log" and "Global gotchas".
4. Then run: `git pull --ff-only` · `git log --oneline -12` · `gh pr list --state open` · `gh issue list --state open --limit 40` · `docker ps` · `gh run list --branch main --limit 3` · the usage tool (`get_usage`).

After reading, give the owner a six-line summary (merged; open PRs and verdicts; contract changes waiting; windows active/quiet; what the owner must do; your first three actions).

## 4. Where the project stands (2026-10-07 end of day; Memory-main's first bullet wins if they differ — it is the authoritative state; the paragraphs below are the 10-05 baseline plus the 10-07 delta)

* **Phase 2 is CLOSED; Integration 2a code is COMPLETE (10-06/10-07, ~40 merges).** Contracts tag **contracts-v0.4.12** (Store API 0.5.4, Admin API 0.4.10, events 0.3.1), db 0.3.3. What exists now: capturePayment + buyShipmentLabel routes, the order lifecycle (pending → confirmed → processing → completed), Stripe Payment Element in the checkout, admin Capture/Buy-label actions, the order-confirmation email worker (apps/notifications, dev sink + Resend), k6 load test with a three-datapoint report, the live CI job seeds OpenFGA, the TOTP barrier is gone (#346). What remains is PROOF: the 2a gate (test-card order → capture → label → refund) needs the owner's Stripe + EasyPost TEST keys (#361). Every window is quiet with a local, unpushed memory commit that rides in its next PR. Standing rule since 10-07: windows never block on an interactive dialog — they ask the manager by message.
* **CI now proves much more than before:** brand A's full browse → buy → account journey against a real core (91 tests), the core's live auth suites, the admin suite against a real core (advisory job), and a performance budget per storefront. The required checks are: ownership, lint + typecheck, unit, contract, secret scan, live auth + end-to-end, storefront performance budget.
* **Known CI hazards (do not "fix" by loosening):**
  * **#346** — two live suites sign `owner` in with the same one-time code; `infra/ci/totp-barrier.sh` separates them by a 30–60 s wait. The real cure is in the test helpers (windows 1 and 2); then remove the barrier.
  * **#348** — brand A's listing-page LCP sits on its 2500 ms Lighthouse budget on CI runners (about 1 failure in 20). Every perf leg prints its per-run numbers; re-run that one leg; window 10 decides with ten runs of data.
* **What is NOT true yet, from `apps/storefronts/brand-a/LAUNCH.md` (47 checklist items, read it):** nothing is deployed, staging included; brand A has no Helm values, ArgoCD app or image repository (**#342**, blocked on an AWS account); the checkout offers only the manual payment provider, and capture and refund exist only for Stripe, so no refundable order can be produced; shopper search is a database text match (Algolia is not deployed); there is no consent gate on the attribution cookie and no alerting.
* **Next: Integration 2 (you).** Plan: order → payment → ship → refund end to end, k6 load test, brand A go-live. On the laptop you can prove order → manual authorise → ship against the real core, and a k6 run (measure `GET /store`: four pool connections per request). Capture, refund and a go-live rehearsal need the owner's accounts first: a domain, AWS, Stripe, Cloudinary (paid plan — 18 of the 19 hero stills exceed 10 MB), Sanity. Write the Integration 2 plan against that truth and get the owner's decisions before starting.
* **Deferred with reasons:** #247 cart-recovery page (useful only once recovery emails exist, Phase 4), #330 hero video (Phase 3: window 6 schema, then window 3), #342, #346, #348, #90.
* **Owner's open items:** the accounts above; lawyer review of the legal copy (48 placeholders); the consent decision; `apps/admin/CLAUDE.md` line 8 is stale ("Admin API 0.4.0", "Phase 1") and only the owner may tell window 4 to change an instruction file.

## 5. Generated media (done; kept outside the repo)

`C:\Users\mehdi\Desktop\commerce-platform-media\{brand-a,brand-b,brand-c,admin}` with a `manifest.json` each (file, size, sha256, slot): heroes at 4K, a 36-image product matrix per brand at 2K (`<category>-<colour>.png`, six seed categories × six seed colours), fabric/hero/product loops and vertical social ads, admin monograms and empty-state SVGs. Brand A's CMS wiring is merged (`cms/brand-a/media/manifest.json`, slots resolved at seed time, owner-run `cms/brand-a/scripts/upload-media.mjs --yes`). Still to do once Cloudinary exists: the upload, and replacing the `picsum.photos` product placeholders in `packages/db/src/seed/index.ts` with the matrix by category + colour (yours). The recipe (models, prompts, costs) is in git history of this file (commit d335979) and in Memory-main.

## 6. The manager loop (details in the runbook)

1. `gh pr list`, the windows' last turns, the usage tool.
2. Per open PR: a background read-only reviewer (Fable for auth/tenancy/outbox/payments/contracts/security, Opus otherwise; small test-only or doc-only diffs you may read yourself). Reviewers are STATIC while any window is measuring. Verdict MERGE or BLOCK; verify the load-bearing claims yourself with `git show origin/<branch>:<path>`.
3. Merge ONLY with `bash scripts/merge-queue.sh "<pr> <branch>" …` as its own single tracked background call, one queue at a time (several PRs may go in one call, in order); a fresh `gh pr view N --json state` before ANY dependent action; tags on the verified merge commit. The queue refuses any red check, advisory included — keep it that way.
4. Issues: decide same-day, route with a label and a decision comment; contract changes land between PRs from `../wt-contracts`.
5. After every round: a new bullet atop Memory-main "Current status", commit + push to main; `pnpm install --frozen-lockfile` after every merge round.
6. When several things are in flight, start the check-in loop: `/loop 20m Manager check-in: …` (the Skill `loop`); stop it when the round is done.

## 7. Talking to the owner and to windows

* To the owner: short, lead with what he must do or decide. Report only what changed. Say plainly when something went wrong and what it cost.
* To a window: one block starting `Manager:` — single and final. Standing rules to repeat when relevant: merge main before pushing; one PR per task; hold pushes until the manager confirms; test keys are words; no closing keyword next to an issue number in a commit message unless the commit finishes the issue; no docker commands; long runs detached, output to a file, bounded poll; rebuild the workspace packages after every merge of main; ONE WINDOW MEASURES AT A TIME — you hand out the machine ("the machine is YOURS") and take it back when the window reports "machine free"; message the manager when a PR is up and again when checks finish.
* A window that needs a second branch for one PR (an urgent fix while its main PR is parked) may have it as a stated one-time exception.

## 8. Environment facts that will bite you

* Windows 11, Git Bash + PowerShell. Use the session scratchpad, never `/tmp`. Long or backslash/regex-heavy scripts: write a file, run the file (heredocs with backslashes break).
* Loopback is 127.0.0.1 for DB/Redis; KEYCLOAK_URL stays `localhost`. turbo strips `DATABASE_URL*`. **`packages/*/dist` goes stale** — rebuild workspace packages after every merge of main (a stale `auth-sdk/dist` made a core treat every token as unverified and looked like a Keycloak fault). ONE shared Docker stack and ONE Keycloak for every worktree.
* **Docker:** stable since 10-01 19:14 after four crashes that day (cause never found). Docker Desktop can show "Engine running" with no backend — trust `docker version`. Recovery: owner restarts Docker Desktop, then `docker compose -p commerce-platform -f infra/docker/docker-compose.yml start` (never up/recreate), verify ports, each worktree re-runs `pnpm --filter @platform/auth-sdk fga:seed`.
* Ports: Postgres 5433, Redis 6381, Keycloak 8180, OpenFGA 8081, Redpanda 19092, mocks 4010/4011, core 9000, admin 3000 (3200 in CI), storefront 3100, brand-a 3101.
* Seed stock: `pnpm --filter @platform/db top-up-stock [floor]` raises every seeded level to 25 available and writes the ledger (run 10-04; the local seed therefore has no naturally sold-out variant). Each full e2e pass buys about five units.
* To show the owner the apps: `.claude/launch.json` (local, git-excluded) has `core`, `brand-a`, `storefront-starter`, `admin`. The core does not start through the preview launcher — run `pnpm --filter @platform/core exec tsx src/server.ts` in the background (about 60 s to boot) and STOP IT explicitly afterwards: it outlives its task wrapper and keeps port 9000. The admin needs `apps/admin/.env.local` (exists locally, gitignored) and a staff sign-in; `owner` has a dev TOTP documented in `infra/keycloak/README.md`.
* GitHub: admins bypass required checks for the manager's docs/config commits to main. GitHub had a short 503 outage on 10-03; `gh` hangs rather than fails — use `timeout`.

## 9. Rules for you

Never push a window's branch from the repo root. Never merge red CI, and never change the queue or CI to make a red check pass. One queue at a time; never chain it; never `&` it; never `rm -rf ../wt-mgr-tmp` yourself. Avoid pushing docs commits to main between a window's final push and its queue (it costs a CI cycle). Close issues only after MERGED; a waiver that closes an issue is written on the issue first. A `docs/ownership.md` edit must run `bash scripts/check-ownership.test.sh` before push. **A CI timing or flake fix is accepted only with repeated runs and per-run evidence — never on reasoning, and a static review cannot certify it** (10-05: a step reorder was called robust and reddened three PRs). Stack interventions (Docker, realm reimport, anything destructive on the shared database) need the owner's OK first. Watch usage: Fable reviewers only where the rule requires them; at 85% of the weekly limit hand out no new tasks; at about 80% of your own context rewrite Memory-main's first bullet, this file and the runbook, commit, push, and tell the owner to open a new manager window with this file.

Begin now with section 3, then the six-line summary, then the Integration 2 plan.
