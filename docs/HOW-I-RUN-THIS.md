# How I run this (solo, Claude Max 5x, one window at a time)

Operating guide only. Architecture and plan live in docs/plan; window state lives in docs/memory.
All commands run from the repo root `C:\Users\mehdi\Desktop\commerce-platform` in Git Bash (or WSL).
Worktrees are created as siblings: `../wt-<key>` (for example `../wt-core`).

## 1. Window order, phase by phase

Sessions = Claude Code sessions of roughly one 5-hour block each. Model "strongest" = the best model available; "Sonnet" = Sonnet.

| Phase | Order | Window | Key | Start message to paste | Model | Sessions |
|---|---|---|---|---|---|---|
| **0 (CURRENT)** | 1 | main (Architect) | main | docs/start-messages/00-main-architect.md | strongest | 3–4 |
| 1 | 1 | 1 | core | docs/start-messages/01-core.md | Sonnet (strongest for the migration tasks) | 8–10 |
| 1 | 2 | 2 | auth | docs/start-messages/02-auth.md | Sonnet (strongest for the OpenFGA model task) | 4–5 |
| 1 | 3 | 3 | storefront | docs/start-messages/03-storefront.md | Sonnet | 8 |
| 1 | 4 | 4 | admin | docs/start-messages/04-admin.md | Sonnet | 8 |
| Int 1 | 1 | main (Integrator) | integration | docs/start-messages/00-integrator.md | strongest | 4 |
| 2 | 1→9 | 1 core, 7 payments, 8 shipping, 9 search, 4 admin, 6 cms, 5 infra, 10 brands (A), 3 storefront | as listed | docs/start-messages/0N-<key>.md | Sonnet (strongest for 7 payments webhook task) | 4–8 each |
| Int 2 | 1 | main (Integrator) | integration | docs/start-messages/00-integrator.md | strongest | 4 |
| 3 | 1→7 | 1 core, 11 warehouse, 4 admin, 2 auth, 12 data, 13 customers, 10 brands (B, C) | as listed | docs/start-messages/NN-<key>.md | Sonnet | 4–6 each |
| Int 3 | 1 | main (Integrator) | integration | docs/start-messages/00-integrator.md | strongest | 3 |
| 4 | 1→3 | 14 events (alone, first), 15 accounting, 16 engagement | as listed | docs/start-messages/14-events.md, 15-accounting.md, 16-engagement.md | 14 and 15: strongest; 16: Sonnet | 6 / 8 / 5 |
| Int 4 | 1 | main (Integrator) | integration | docs/start-messages/00-integrator.md | strongest | 3 |
| 5 | 1 | 12 data | data | docs/start-messages/12-data.md | Sonnet | 8 |
| Int 5 | 1 | main (Integrator) | integration | docs/start-messages/00-integrator.md | strongest | 2 |
| 6 | — | main | main | ad hoc | strongest | ongoing |

Never open the next window in a phase until the previous one is closed (section 5). Never run two build windows at once.

## 1b. Parallel mode (several build windows at once, this window = manager)

The repo root `commerce-platform` is the **manager window only**: it reviews, merges, integrates, edits Memory-main and
contracts. It never builds features. Each build window lives in its own **git worktree** (a sibling folder sharing the
same repo and remote), on its own branch, with its own `node_modules`. Never open two Claude windows in the same folder:
they would fight over one checked-out branch.

| Terminal | Folder | Branch | Paste | Model |
|---|---|---|---|---|
| manager (this) | `commerce-platform` | `main` | docs/start-messages/00-reviewer.md when reviewing; otherwise you talk to it directly | strongest |
| 1 | `../wt-core` | `core/phase1` | docs/start-messages/01-core.md | Sonnet (strongest for [core] 1.3, 1.5) |
| 2 | `../wt-auth` | `auth/phase1` | docs/start-messages/02-auth.md | Sonnet (strongest for [auth] 1.2) |
| 3 | `../wt-storefront` | `storefront/phase1` | docs/start-messages/03-storefront.md | Sonnet |
| 4 | `../wt-admin` | `admin/phase1` | docs/start-messages/04-admin.md | Sonnet |
| 5 | `../wt-infra` | `infra/phase2` | docs/start-messages/05-infra.md | Sonnet |

Each build window: `cd ../wt-<key> && pnpm install && claude`, paste its start message, pick the model.
Shared things that are safe in parallel: the docker stack (`pnpm dev` from any worktree reuses the same containers; tests
create their own databases), the mocks on 4010/4011, GitHub issues. Dev-server ports are fixed per app: core 9000,
admin 3000, storefront 3100. `pnpm-lock.yaml` may change on every branch; the manager re-runs `pnpm install` after each
merge and commits the lockfile on `main`.

Manager loop while windows run: (1) `gh pr list` → for each green PR, Reviewer session `/review <PR>` → merge with
`gh pr merge <PR> --squash`; (2) after every merge, in the repo root: `git pull --ff-only && pnpm install && pnpm test`,
commit the lockfile if it changed; (3) triage issues labelled `contract-change` / `request` (accept → the manager applies
the change on `main` and regenerates; reject → comment why); (4) tell the other windows to `git merge main` in their
worktree when something they depend on has landed (auth-sdk for core, ui for storefront); (5) keep Memory-main
"Current status" current. The windows never pull each other's branches.

## 2. Starting a window (copy-paste)

Phase 1, window 1 (core). Same shape for every window: `new-window.sh <window> <phase>`, then `cd ../wt-<key>`.

```bash
./scripts/new-window.sh 1 1
```
```bash
cd ../wt-core && claude
```
Then paste the whole file below the `---` line of `docs/start-messages/01-core.md` (open it from the repo root: `C:\Users\mehdi\Desktop\commerce-platform\docs\start-messages\01-core.md`). Pick the model in the Claude Code model picker before pasting.

The other Phase 1 windows, in order:

```bash
./scripts/new-window.sh 2 1 && cd ../wt-auth && claude        # paste docs/start-messages/02-auth.md
```
```bash
./scripts/new-window.sh 3 1 && cd ../wt-storefront && claude  # paste docs/start-messages/03-storefront.md
```
```bash
./scripts/new-window.sh 4 1 && cd ../wt-admin && claude       # paste docs/start-messages/04-admin.md
```

Phase 2 and later: same commands with the phase number changed, for example `./scripts/new-window.sh 7 2 && cd ../wt-payments && claude`, paste `docs/start-messages/07-payments.md`. The script prints the exact start-message path at the end; use that.

The script writes `.claude/CLAUDE.local.md` inside the worktree (the window's identity) and creates branch `<key>/phase<N>` from `main`.

## 3. When a session ends or context fills

Before context fills (Claude says the context is long, or a task just finished):
```
/save
```
then, if it says so:
```
/compact
```

New session in the same worktree (new day, crash, or after `/compact` felt lossy):
```bash
cd ../wt-core && claude
```
```
/resume
```

How to tell whether it finished or stopped mid-task: open `docs/memory/Memory-1-core.md` (or the window's file).
- **Finished**: the task is under `Done` with a commit sha, `In progress` is empty, `git status` in the worktree is clean, and a PR exists (`gh pr list --head core/phase1`).
- **Stopped mid-task**: the task is under `In progress` with open files listed, or `git status` shows uncommitted changes. `/resume` continues from `In progress`; do not paste the start message again.
- **Memory not updated but code changed**: run `/resume`, then tell it "update the memory file from git log and git status first".

## 4. When a window says a task is done: review and merge

1. Confirm a PR exists and CI is green: `gh pr list --head core/phase1` then `gh pr checks <PR>`.
2. Open a **separate** Reviewer session in the repo root (Sonnet), never in the worktree:
```bash
claude
```
```
/review <PR>
```
3. The reply is exactly `MERGE` or `BLOCK` with numbered reasons.
   - **MERGE**: `gh pr merge <PR> --squash --delete-branch=false`, close the Reviewer session, go back to the build window and say "PR <PR> merged, continue with the next task".
   - **BLOCK**: paste the numbered reasons into the build window as-is ("Reviewer blocked PR <PR>: ..."), let it fix, push, then run `/review <PR>` again in a fresh Reviewer session. Never fix it yourself in the worktree.
4. Never merge from inside the build window. Never merge a red CI. The ownership check failing is always a BLOCK.

## 5. Closing a window at the end of its phase

Must be true before you close it:
- Every item of the window's `Next` list is under `Done` with a sha, or explicitly moved to `Later phases` with a reason.
- Last PR merged, `git status` clean in the worktree, and the window's memory file says the exact next step for the next phase.
- No open `CONTRACT CHANGE` issue from this window that is unlabelled (each must carry `contract-change` and `window:<key>`).

Then, from the repo root:
```bash
git pull --ff-only origin main
```
```bash
git worktree remove ../wt-core
```
(`git worktree remove --force ../wt-core` only if it refuses because of stray files you have checked.) The branch `core/phase1` stays on GitHub as history.

Before opening the next window: `pnpm install && pnpm lint && pnpm typecheck && pnpm test` green on `main`, and Memory-main "Current status" updated by you with one line: "window 1 closed <date>, next: window 2".

## 6. Integration procedure

Triggers: the last window of a phase is closed (section 5), or the phase gate date in Memory-main arrives.

```bash
git worktree add ../wt-integration -b integration/phase1 main && cd ../wt-integration && claude
```
Model: strongest. Paste `docs/start-messages/00-integrator.md` with `<N>` replaced by the phase number. It merges the window branches, applies accepted contract changes, replaces mocks, runs e2e, writes the report, rewrites the next phase's memory files, and opens one PR `integration/phase<N>` → `main`.

My sign-off checklist (the "Gate" column of Memory-main phase plan), before I run `/review` on that PR:
- Int 1: one checkout end to end in staging with the test PSP; store admin cannot open Finance.
- Int 2: real test-mode order, refund, and shipping label; k6 load test result attached; go-live checklist for brand 1 ticked.
- Int 3: a brand onboarded from the HQ UI; two brands served from one stock pool.
- Int 4: ledger equals PSP payouts to the cent for one month; finance owner has signed off.
- Int 5: BI numbers equal ledger equal PSP; access review done for every role.

After MERGE: tag as the report says (`git tag contracts-v0.<N+1> && git push --tags`), then `git worktree remove ../wt-integration`, then section 2 for the next phase's first window.

## 7. If something goes wrong

**Window edited files it does not own** (CI ownership check red, or `/review` says so): BLOCK the PR. In the build window: "Revert every change outside your owned paths, file a CONTRACT CHANGE or REQUEST issue for what you needed, keep building against a local mock". If it needed the change to proceed at all, close the window early and add the issue to the next integration period. Never approve the file just to move on.

**Two windows touched the same file** (only possible across phases, since one runs at a time): the file was misassigned. The Integrator resolves it in the next integration and updates docs/ownership.md; until then the later window works against a copy inside its own paths and files a REQUEST issue.

**Window lost track of what it did**: in the worktree run `/resume`; if the memory file is stale say "rebuild Done/In progress from `git log --oneline -30` and `git status`, then update the memory file and commit it". If the worktree itself is confused: `git stash`, `git log`, decide, `git stash pop`. Last resort: `git worktree remove --force ../wt-<key>`, then `./scripts/new-window.sh <n> <phase>` again; the branch on GitHub keeps the commits.

**Usage limit mid-task**: type `/save` immediately if it still answers; otherwise wait for the 5-hour reset, reopen the same worktree, `/resume`. Do not start a Reviewer session or the chat app while waiting. If the task was half-committed, the memory file's `In progress` is the truth.

**Merge conflict on main** (a PR cannot be merged): do not resolve in the build window. Open the Reviewer session in the repo root and say "rebase PR <PR> onto main, resolve conflicts keeping main's version of any file the branch does not own, push". Then `/review <PR>` again. If the conflict is inside packages/contracts, packages/events, or packages/db, stop: that is integration work, park the PR until the next integration period.

**CI red for a reason outside the window's paths** (flaky infra, a root config bug): fix it yourself on `main` in the repo root with a one-line commit prefixed `main:`, push, then re-run the PR checks with `gh pr checks <PR> --watch`.

## 8. Daily and weekly rhythm

**Every morning**
1. `git pull --ff-only origin main` in the repo root.
2. Read the active window's memory file (2 minutes). Read Memory-main "Current status" (1 minute).
3. Check `/usage` in any Claude Code session. Under 60% weekly: build. Over 60% by Wednesday: docs and tests only until reset.
4. Open the active worktree, `/resume`, one task to done, `/save`, PR opened. Aim for 2–3 tasks per session, Monday to Thursday morning.

**After the 5-hour reset**
1. Reviewer session for each open PR (section 4), merge or block, close the session.
2. If usage allows, one more task in the build window; end with `/save`.

**Friday**
1. No features. In the build window: "tidy: READMEs, CHANGELOG, failing or skipped tests, then `/save`".
2. Write next week's GitHub issues for the active window (acceptance criteria included), label `window:<key>`.
3. `/compact` the build window. Update Memory-main "Current status" by hand with one line.
4. Check `/usage` once more; if over 60% for the week, the next build session waits for the weekly reset.

**Never**: two build windows at once, heavy Claude chat on build days, merging your own PR, force-push, touching production credentials from a window.
