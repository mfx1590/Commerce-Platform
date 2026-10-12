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
  A defect the review finds OUTSIDE the author's ownership does not block the PR: route it (urgent issue + a wake
  of the owning window) and merge — precedent #273/#277. The issue's own criteria may not be swapped for the PR's;
  either meet them or record a manager waiver.
- Re-check a fix yourself with `git show`/`grep` when the fix is mechanical; spawn a re-review only when it is not.
- Ask reviewers for EVIDENCE, not confirmation: recompute contrast ratios, blob-hash a re-sync against its source,
  mutation-test a guard, run the exploit shape. Windows' own record must match the code (stale figures, false
  counts and drifting docs are the same defect class as bugs and block the same way).
- Do not paste a window's verdict from memory of the review — quote from the reviewer's report. A mid-relay
  correction becomes two contradictory pastes in the window's context; every paste is single and final.
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
- **The queue runs ONLY as its own single-command call, tracked in the background — never chained after other commands, never launched with shell `&`** (three detached launches in Sept 2026: output lost, one refused run went invisible, kills left file locks that aborted the next run's temp worktree). If a detached queue is suspected, find it with a process listing before starting another; two queues collide on `../wt-mgr-tmp`.
- **Nothing merge-dependent runs before a fresh `gh pr view N --json state` says MERGED** — not the tag, not the issue close, not the paste. A queue run can die silently (a transient DNS failure once made it SKIP the PR while chained follow-ups tagged an unmerged state; the tag had to be deleted both sides and the issue reopened).
- GitHub parses closing keywords in PR bodies ASYNCHRONOUSLY: scan the body for close/fix/resolve near issue numbers before creating, and check `closingIssuesReferences` again ~30 s after opening — an immediate empty read is not proof (window 4, twice).
- **A contracts landing runs the CONSUMER packages' suites** (core/admin/storefront), not just the contracts package: request-validation and generated-type interactions surface only there (the frozen-SegmentRules landing broke a marketing route test that only CI caught; the review-shape landing broke admin and core typecheck locally). `format:check` is part of the local gates. A landing commit may adjust consumer TESTS and delete superseded `proposed/` copies + test-side DDL, but never implements a window's production code — if the contract cannot be truthful without core work, land the truthful weaker form (e.g. optional-until-returned) and record the deviation on the issue.

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

## 5. Messages to windows (pasted by the owner until 2026-10-05; sent by the manager since — see section 12)

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

## 10. Public repo, branch protection, and the queue (learned 2026-09-14/15)

- The repo is public since 2026-09-09: Actions minutes are free, the billing refusals ("job was not started because recent
  account payments have failed") are gone. Branch protection on `main` requires five checks (ownership, lint + typecheck,
  unit, contract, secret scan); the manager's direct Memory-main commits bypass it as admin — that is intended.
- Close a task issue only after `gh pr view N --json state` says MERGED. The queue refuses on any red check (except the
  advisory `app images`); twice an issue was closed on a refused queue and had to be reopened.
- A refused queue with a `non-lockfile conflicts:` line means the window must merge main and resolve — the queue never
  resolves conflicts. A refused queue whose only red job is `live auth + end-to-end` needs the job log: since #210 that job
  boots the core (a loader/plugin failure fails it) and runs brand journeys only with `E2E_INCLUDE_BRAND_STOREFRONTS=1`.
- Post-merge reviews exist: when a task rides into main inside another PR (search 2.5 in #188), review it on main and file a
  follow-up issue instead of pretending it was reviewed.
- Windows must merge main BEFORE pushing so the queue's own merge is a no-op (fewer CI runs), and hold every push until the
  manager confirms a merge — a branch push is all-or-nothing and can carry unreviewed work into an open PR.

## 11. Mechanics learned 2026-09-29 → 10-03 (manager session three)

- **One window measures at a time.** One laptop: a build or Lighthouse run in one window makes another window's e2e time out, and the "evidence" from both is worthless (window 10 wrote a worker cap on numbers taken during window 3's build). The manager hands the machine to exactly one window ("the machine is YOURS now"), the window reports "machine free", then the next gets it. Code-only work continues in the others.
- **Reviewers are static while anyone measures.** Review prompts carry HARD LIMITS: no builds, suites, servers or docker; the diff, files on the branch and CI logs are the evidence. Reviewers must never run Playwright against servers another session owns.
- **CI is the independent datapoint for "is it my change or the laptop?"** Window 3 lost half a day to page.goto timeouts that passed on GitHub in 44 s; the cause was Playwright's readiness resolving on response headers seconds after the build (fixed by a warm-readiness gate in the starter's e2e-server). Push a DRAFT and read CI before alternating local runs.
- **Hung steps.** Three times a window sat 15–30 min on a step with nothing running (a server started in the foreground of the call; a pipe held open). Check the machine before believing the timer: `Get-Process node`, the ports, CPU. Standing window rule: long runs detached, output to a file, bounded poll.
- **Queue wrapper timeout.** The Bash wrapper dies at 10 minutes; `merge-queue.sh` keeps running and merges on its own. Do NOT start another queue: poll `gh pr view N --json state` and `ps -ef | grep merge-queue` until the process exits. A queue needs a full CI cycle whenever main moved after the window's last push — so do not push docs commits to main between a window's final push and its queue.
- **Never clean `../wt-mgr-tmp` yourself.** A background `rm -rf` of it raced the queue's own cleanup, `git worktree add` failed and the queue skipped the PR (nothing pushed). The script removes it at start.
- **Closing keywords in COMMIT messages close issues too** ("A follow-up closes #142" closed #142 when #294 merged; reopened by hand). `closingIssuesReferences` only reflects the PR body — scan `git log origin/main..origin/<branch> --format=%B` in every review.
- **`docs/ownership.md` edits:** run `bash scripts/check-ownership.test.sh` before pushing (the self-test encodes the rows; a stale case turned every PR's ownership job red for an hour), and keep notes in the glob column as plain text — every backticked token there is parsed as a glob.
- **`pnpm install --frozen-lockfile` after every merge round,** not only when a lockfile diff is noticed (a missing local install looked like a main typecheck failure).
- **Contracts landings may delegate consumer suites to the PR's CI** when the laptop is in use (0.4.8, 0.4.9 did); a red consumer job blocks the merge. Spec edits go through an asserted script (exact-match replacements + `append_responses` per operation), then generate, spec tests, prettier, CHANGELOG, README table.
- **Recorded-deviation pattern** when the core is ahead of the contract (a status the spec does not document yet): keep the behaviour if it is the house rule, record it on the issue, name it in the PR body/README, and document it in the next contracts landing. When the contract is ahead of the core: land the weaker truthful form and flip later.
- **A ruling must say who may see the result.** "A replay answers the stored order" let PR C return one customer's order to another principal. Rulings about reads name the principal.
- **Preserved files in clones drift silently.** Brand A's sync never overwrites `next.config.mjs`, `src/brand/config.ts`, `playwright.config.ts`, `lighthouserc.json`; four starter fixes never reached it. `sync --check` now reports preserved files whose starter counterpart changed (window 10, re-sync PR).
- **Generated media lives outside the repo** (`C:\Users\mehdi\Desktop\commerce-platform-media\<brand>` + manifest); the repo holds only a manifest with Cloudinary ids. Recipe in `docs/start-messages/00-manager-resume.md` §5.

## 12. Mechanics learned 2026-10-03 → 10-05 (manager session four; Phase 2 closed)

- **The manager messages the windows directly** (owner's decision, 10-05). `list_sessions` finds a window by title and `cwd`; `send_message` delivers one `Manager:` block ("delivered" = its turn started, "queued" = it runs after the window's current turn); `list_events` reads its last turn. Windows report back by messaging the manager session twice: PR up (number + head sha), then checks finished. They forget about one time in three — `gh pr list` is the truth. The manager cannot create sessions; a new window is the owner's step. Twelve PRs merged on the first day of this, against six or seven a day with hand relay.
- **The check-in loop.** With several things in flight, `/loop 20m Manager check-in: …` wakes the manager to read the PR list and the windows' last turns. Without it the manager only runs when a window messages, a background task ends, or the owner writes. Stop the loop when the round is done.
- **A CI timing or flake fix needs repeated runs with per-run evidence. Reasoning is not evidence and a static review cannot certify timing.** #344 put a second `owner` sign-in into the required live job and separated the two suites by step ORDER; the reviewer called it robust; three PRs in a row went red (`token for owner: invalid_grant`). #347 separates them by a computed TOTP-step gap and prints a witness table from Keycloak's event log; five consecutive runs were quoted before it merged. Ask for: N consecutive runs on one head, all attempts listed (so none is hidden), and the measured quantity per run.
- **A new required-path job is proven before it is trusted:** three consecutive green runs on the draft, counts in the PR body (#339, #341). A job that is red for reasons in another window's paths waits unmerged until that window's fix is on main — the queue refuses any red check, advisory included, and an attempt to exempt "(advisory)" checks was refused by the harness as a CI bypass. That refusal is right; do not look for a way round it.
- **Advisory jobs still gate their own PR.** `admin e2e against the core (advisory)` is not in branch protection; promote it after a week of green runs.
- **Perf gate.** Since #336 the required check `storefront performance budget (bundle + Lighthouse)` is an aggregate over one leg per storefront; the aggregate keeps the exact required name. LHCI's default for a max assertion is `optimistic` = the BEST of three runs. Passing legs printed nothing until #349; now every leg prints per-run values, the CPU benchmark and the margin. Brand A's listing page is marginal (#348).
- **Waivers.** A criterion that cannot be met on a laptop (a staging dry run, Google's validator, CMS routes without a Sanity project) is waived in writing ON THE ISSUE before the PR merges, and the gate moves to the launch checklist (`apps/storefronts/brand-a/LAUNCH.md`) — #142, #144.
- **Scope calls that closed Phase 2:** work that produces artefacts nobody can run is deferred with an issue, not built (#342: a Keycloak deployment with no cluster). Say so to the owner the same hour.
- **Stale `dist`.** After every merge of main: rebuild the workspace packages before starting a core. A stale `packages/auth-sdk/dist` read every token as unverified and was mis-diagnosed as a Keycloak fault; the live realm was checked read-only with `node infra/keycloak/reimport.mjs --export customers` and the admin API before anything was reimported.
- **gitleaks.** `[allowlist]` cannot sit next to `[[allowlists]]` (8.30); a GLOBAL allowlist with `paths` exempts the whole file whatever `condition` says — only an allowlist with `targetRules` honours `condition = "AND"`. Mutation-test every new entry (the thing passes; another secret in the same file fails; the same string elsewhere fails).
- **Windows refuse some things correctly:** a window will not edit its own `CLAUDE.md` because another session asked, and will not wipe shared data for a test. Route those to the owner; design the test so it creates its own data.
- **Usage pacing.** `get_usage` each round. Fable is the scarce one: use it for the reviews the rule names, read small diffs yourself. Thresholds are in `00-manager-resume.md` §9.
- **Showing the owner the apps** costs the machine: stop the core explicitly afterwards (it outlives its background wrapper and holds port 9000).
- **The PR number and head sha are recorded AFTER the push, as the window's own next step** — they do not exist before it; "memory updated before pushing" is backwards for those two fields (10-07/10-08: #408, #411 reviews caught records lagging the work). Reviewers check it; a missing record is a one-commit memory push before the queue. **Accepted form (10-08, #421/#424):** "PR #N open (code commit <sha>; head = this memory commit on top of <merge-of-main sha>)" — the memory commit cannot name its own sha, so the code commit is the literal and the head is the memory commit; the PR number must be literal. A reviewer who finds "head = this memory commit" does not block on it.
- **Budget since 2026-10-08: Max 5x = the manager plus two build windows at a time (three sessions total).** Fable reviewers only for auth/tenancy/outbox/payments/contracts; small diffs read by the manager; one queue and one review at a time.

## 13. Mechanics learned 2026-10-08 → 10-09 (manager session five; Phase 3 started)

- **Owner rules added 10-08:** the manager STOPS at 80% of the 5-hour usage limit (one-shot cron a couple of minutes after `resetsAt`, suspend the 20-min check-in loop, resume by timer); three Fable sessions burn the 5-hour window fastest — window models are the owner's call (window 1 ran on Opus for Phase 3; Fable reviewers only for auth/tenancy/outbox/payments/contracts, everything else Opus, small or test-only diffs read by the manager).
- **The owner may be away:** "do not invent work" while a key is missing; when told "proceed", move to the next phase and tell the owner exactly when a key or decision is needed (keys for the 2a gate → deferred to the launch checklist as a recorded waiver, issues stay open as gate records).
- **An existing quiet window is a slot the manager can activate itself** (`list_sessions` by cwd, one `Manager:` block naming this session); only a window that needs a NEW worktree is the owner's step. Set your own session title (`set_session_title`) so windows can address you; put every active window's session id in the check-in cron prompt; the first turn of a freshly opened window costs usage — open it after a reset.
- **Record form (10-08):** "PR #N (code commit <sha>; head = this memory commit)" — a commit cannot name its own sha; the memory commit on top IS the head; a stale `head = <old>` after a follow-up commit needs one more record commit before the queue.
- **Integration landings on top of a window's head:** a change that cannot precede the window's work on main (a new workspace package must be COPYed in the deps stage of EVERY Dockerfile — `infra/ci/check-image-manifests.sh`; the package exists only with the brand PR) is landed as `integration/<name>` cut from the window's final head + one manager commit; the queue merges the integration PR, GitHub marks the window's PR merged, the window's `Closes #N` commit closes the issue. Integration branches may write anywhere (`check-ownership.sh`).
- **Contract landings:** asserted exact-match edit scripts (write the script to a file; a `\n` inside a patched string literal once became a real newline and broke the script); every anchor asserted; prettier after; `generate` then compare the generated types before/after formatting; consumer typechecks need a workspace rebuild first (a stale `auth-sdk/dist` in `../wt-contracts` failed the core typecheck and looked like the landing's fault). Both `--filter` landings + CHANGELOG + README table + spec-test version regex + Memory-main contract log; tag on the verified merge commit.
- **Docs pushes to main cancel the in-progress main run** (concurrency) — a cancelled run neither counts nor breaks #348's streak, but hold docs commits until the merge's own run finished (one-shot cron with a capped wait), so every merge counts a perf leg.
- **A CI "check the machine" read must discriminate:** chrome process counts and a stale `.last-run.json` are not evidence (the owner's own browser; the previous run's record); automation flags, user-data-dir, start times and the log's mtime are. Never instruct a blanket kill; ask the window for its log tail; the window may rightly refuse.
- **A proof must be legible in CI:** Playwright's github reporter does not name skipped tests and a `test.skip(reason)` prints nothing — specs print a line on pass (order id) and on skip (reason) so a leg's log answers "ran or skipped". A reviewer who cannot tell the two apart blocks.
- **Windows refuse correctly:** no docker, no shared-realm reimport without a word, no shared-DB UPDATE (the seed is `ON CONFLICT DO NOTHING`, so a long-lived local store keeps old settings — the fix is the owner's OK + `updateStore` as store-admin), no killing processes on a count. Route those to the owner.
- **Keycloak realm reimport deletes the realm before importing** — a rejected file (a client description > 255 chars) leaves the realm absent until the last good file is re-imported; validate statically first; never put a non-realm JSON at the top level of `infra/keycloak/` (compose mounts the folder as the import dir; eslint lints `**/*.config.*` as scripts).
- **The first single-locale brand (B) and the first non-starter-locale brand (C) exposed the starter's baked identity:** the Keycloak client id default (sessions minted for the wrong store — fail closed), locale literals in synced specs/warm-up/catalogue tests, an NL address in the journey helper and its review-page assertion, and the single-store Prism mock (the perf job measures against it → per-brand `perf/store.example.json`, #448). Brand legs are core legs in the live job; the perf job is mock-only by design. A brand's exclusions in its own preserved files are the stopgap; the starter fix is the cure (one REQUEST per class, window 3). Expect the same for the next starter-level assumption.
- **GitHub parses closing keywords in PR-body prose** ("PR B … closes #428" closed-ref #428 from PR A's body) — scan bodies for close/fix/resolve near ANY issue number, not only the task's.
- **Queue hygiene held:** one queue at a time as its own background call; several PRs in one call in order when the second needs the first on main (#432 then #429); `gh pr view --json state` before any dependent step; a GitHub-marked-merged PR (its commits landed via another PR) needs no close.
