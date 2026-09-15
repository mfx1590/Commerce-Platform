# Manager handoff — how the manager window actually operates (written 2026-09-08 at the Phase 1 → Integration 1 boundary)

The manager window is the repo root on `main`. It never builds features. It reviews, decides, merges, integrates,
and keeps `docs/memory/Memory-main.md` true. This file is the practical runbook the previous manager learned by doing;
`docs/HOW-I-RUN-THIS.md` is the owner's guide, `Memory-main.md` is the state.

## 1. The loop

1. `bash scripts/status.sh` — one line per window, open PRs with CI, open CONTRACT CHANGE / REQUEST issues.
2. For each open PR: **review** (section 2) → verdict → **merge queue** (section 3) → close the issue → record in Memory-main.
3. For each `CONTRACT CHANGE:` / `REQUEST:` issue: **decide** (section 4) the same day. Never let windows wait on a decision.
4. Give the owner one paste-ready message per window (section 5). The owner relays; windows never see this window.
5. After every merge round: `git pull --ff-only`, and if `pnpm-lock.yaml` moved, `pnpm install --frozen-lockfile`.
   Full verification (`pnpm lint && pnpm typecheck && pnpm test`) once per round, not per PR — CI already ran per PR.

## 2. Reviewing a PR (the only way code reaches main)

Spawn a background review agent per PR (the `Agent` tool, `general-purpose`, `run_in_background: true`). Prompt shape that works:

- Repo, PR number, branch; "Do NOT modify files or change git state. Do not merge."
- "Read first": the issue with the acceptance criteria (`gh issue view N`), the relevant ADR(s), the contract file, the package
  CLAUDE.md on the branch, the window's memory file on the branch, Memory-main "Global gotchas".
- "Check with evidence (paths/lines)": (1) files only inside the branch's owned paths per `docs/ownership.md` (+ its memory
  file, `.claude/CLAUDE.local.md`, `pnpm-lock.yaml`) — anything else is a violation; (2) the acceptance criteria item by
  item; (3) the invariants: tenant client only / no raw `pg`, outbox in the same transaction, permission checked server-side,
  no secrets, no PII in events or logs; (4) tests real, CI green; (5) memory file updated with the sha.
- "Reply with exactly one first line MERGE or BLOCK, then numbered reasons. Under 350 words."
- Model: **Fable for anything touching auth, tenancy/RLS, the outbox, payments, or contracts; Opus for the rest.**
  Five parallel reviewers on Fable will hit the session limit; stagger or use Opus.
- BLOCK only on real defects or missing acceptance criteria. Cosmetic items go in the paste as "nits, not now".
- Re-check a fix yourself with `git show`/`grep` when the fix is mechanical; spawn a re-review only when it is not.
- A PR whose branch conflicts with main gets **zero** checks (GitHub cannot build the merge ref). Tell the window to
  merge main; do not read "no checks" as an outage.

## 3. Merging (scripts/merge-queue.sh)

`bash scripts/merge-queue.sh "98 infra/phase2" "101 storefront/phase1"` — sequential, one temp worktree, each PR: merge
`origin/main` into a detached checkout (lockfile conflicts regenerated), push `HEAD:refs/heads/<branch>`, wait for CI
(ignores the advisory `app images` check), merge with a **merge commit** (`--merge`, never squash — windows keep
building on the same branch). Refuses on red CI and says so. Run it in the background; it takes 10–20 min per PR.

Rules learned the hard way:
- Never `git push origin <branch>` from the manager's repo root: the local ref belongs to the window's worktree and may
  carry unpushed commits (that is how admin 1.2–1.4 got pushed into #42 by accident).
- If the window pushes while the queue runs, the queue's push is rejected → re-run the queue; nothing is lost.
- Tell the window "approved, merging" and then **don't let it push** until you confirm the merge.
- Two queues at once collide on the temp worktree. One at a time.
- Landing a contract change on main while a window's PR is open can break that PR at merge time (see #100 vs #101).
  Prefer: merge the PR first, then land the contract change, then have the window clean up in a small follow-up PR.
- After merging: close the task issue with the PR number; reopen it if the merge was refused (don't close early).
- **The queue cannot be stopped once it waits on CI** (learned at Int 1: a "stop" killed only the wrapper; the script pushed and merged anyway). Start it only when nothing else must land first. To abort a running queue, push any commit to the PR branch: the queue's own push is rejected and it exits without merging.

## 4. Deciding CONTRACT CHANGE / REQUEST issues

- Root config (`.prettierignore`, `eslint.config.mjs`, `.env.example`, `docs/ownership.md`, `packages/*`): the manager
  applies it on main the same day, comments "Applied on main in <sha>", closes the issue. Small and boring is right.
- A request that belongs to another window's paths: comment the decision, label `window:<key>`, and tell that window
  in its next paste. Never apply it yourself into their paths.
- Contract changes: accept if additive and consistent with `docs/domain.md`; apply to `packages/contracts/openapi/*.yaml`,
  bump `info.version` and `CONTRACTS_VERSION`, `pnpm --filter @platform/contracts generate`, run contract tests, CHANGELOG,
  log it under "Contract change log" in Memory-main, tag `contracts-vX.Y` at the next phase boundary. Breaking changes wait
  for an integration period.
- Anything the plan didn't name (a library, a port, a tag): decide, write the reason in Memory-main, move on.

## 5. Paste messages

One fenced block per window, starting `Manager:`, containing only: what merged, what to `git pull`/`pnpm install`, the
verdict and exact fix if BLOCK, the next task and its issue number, decisions on their requests, nits marked as not-now.
Windows are told "keep building the next task locally; push it as its own PR after the previous merges".

## 6. Shared stack etiquette (windows share one docker stack on this machine)

Never `pnpm dev --reset` / `docker compose down` while windows are active; realm changes via
`node infra/keycloak/reimport.mjs <realm>`; ports: Postgres 5433, Redis 6381, Keycloak 8180, OpenFGA 8081 (playground 18083), Redpanda 19092,
mocks 4010/4011, observability (2.5) Grafana 3400 / Loki 3410 / Tempo 3420 / Prometheus 9090 / OTel 4317-4318.

## 7. Platform facts

- GitHub Free + private repo: **no branch protection** (API 403). The merge queue and the review step are the only gates.
  Windows must never push to main. Owner set an Actions budget of $15/month after minutes ran out on 2026-09-07.
- Image builds are the CI cost driver; on PRs they run only when a Dockerfile / docker config / CI script changes (#87).
- The e2e job (`live auth + end-to-end`) boots Keycloak + OpenFGA and runs the live auth suites and Playwright journeys (~4 min).

## 8. Where things are

- State: `docs/memory/Memory-main.md` (Current status, Contract change log, Global gotchas — read all three first).
- Per window: `docs/memory/Memory-<n>-<key>.md` on that window's branch (the copy on main lags until merged).
- Contracts: `packages/contracts/openapi/*.yaml` (Store 0.3.0, Admin 0.3.0 since contracts-v0.3), events `packages/events/schemas` (31 topics),
  schema `packages/db/migrations` (0001–0009 + events 0100 + 0110 metrics + 0120 marketing), domain `docs/domain.md`, ADRs `docs/adr/`,
  marketing scope `docs/marketing-scope.md`.
- Owner-facing guide: `docs/HOW-I-RUN-THIS.md`. Start messages: `docs/start-messages/`.

## 9. Integration periods (learned at Int 1, 2026-09-08)

- The integrator is this window in `../wt-integration` on `integration/phaseN`; delegate the three independent chunks
  (contracts, core wiring, app switches) to parallel agents on distinct paths, keep git in your own hands, commit once.
- Bring the stack up yourself (`pnpm dev` is idempotent: compose up, migrate, seed); windows must not `compose down`.
- Phase N+1 issues: write one spec file (`### <n> <key> <task> <title>` + Task + `- [ ]` criteria), create with a script,
  then rewrite the memory files from the issue map. `./scripts/new-window.sh <n> <phase>` now switches an existing worktree
  to the new phase branch.

