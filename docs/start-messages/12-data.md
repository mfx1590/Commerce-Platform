# Start message — Window 12: Data platform & BI (Phase 5)
Paste into a NEW Claude Code session opened IN the folder `C:\Users\mehdi\Desktop\wt-data` (worktree option OFF).
The Phase 3 version of this file is in git history.

---

You are window 12 — DATA (data platform & BI), Phase 5. Your manager is the repo-root session "Manager session nine".

Read, in this order: CLAUDE.md, docs/ownership.md (row `data/`), docs/memory/Memory-main.md (the first bullet under "Current status" and "Global gotchas" only), docs/memory/Memory-12-data.md (start with the PHASE 5 DOCKET at the top), docs/plan/phase5-plan.md (decisions D1–D12 are binding), then GitHub issues #612 (tracking), #600 and #601.

Then:
1. Rewrite `.claude/CLAUDE.local.md` (yours, git-excluded) to say: "I am window 12 (data). I write only: data/**, apps/analytics-ingest/**, apps/core/src/modules/reporting/**, apps/admin/src/app/(hq)/bi/**, apps/admin/test/bi/**, apps/admin/test-contract/bi/**, apps/admin/e2e/bi/**. Contracts are frozen at the tag named in Memory-main. My memory file is docs/memory/Memory-12-data.md. Branch: data/phase5."
2. Set up: `git fetch origin` · `git switch -c data/phase5 origin/main` · `pnpm install --frozen-lockfile` · rebuild the workspace packages · `pnpm --filter @platform/auth-sdk fga:seed`. No docker commands, ever: the manager runs the shared stack.
3. Work on #600 (P5.1 ingest), then #601 (P5.2 models), one PR each, acceptance criteria in the PR body. ClickHouse arrives in the shared stack with the manager's step-0 PR (HTTP 18123, native 19000). Until the manager tells you it is on main, write the code and the unit tests and keep the ClickHouse-backed tests behind a skip that prints its reason. Pick the official `@clickhouse/client` at an exact version.
4. Design notes that bite: idempotency is `(topic, event_id)` in a ReplacingMergeTree; offsets are committed only after ClickHouse acknowledges the insert; invalid or unknown-version events go to the DLQ, and the DLQ watch must follow the same group override (the #599 lesson); no PII in ClickHouse; money in integer minor units, never summed across currencies; ClickHouse never recomputes ledger revenue (D7).
5. Rules: one window measures at a time, so ask the manager for "the machine" before any live or long run and report "machine free" after; long runs detached, output to a file, bounded polling; a new required-CI step needs three consecutive green runs on one head, recorded in the PR body; nothing secret-shaped in tests (use words); no closing keyword next to an issue number in a commit message unless that commit finishes the issue; merge main before pushing.
6. Message the manager ("Manager session nine") twice per PR: when it is up (PR number + head sha) and when every check has finished. Update your memory file after every task and before every commit.

Start by summarising in five lines what you will build for #600 and how you will test it, then begin.
