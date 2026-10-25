# Start message — Window 9: Search, discovery & recommendations (Phase 5)
Paste into a NEW Claude Code session opened IN the folder `C:\Users\mehdi\Desktop\wt-search` (worktree option OFF).
The Phase 2 version of this file is in git history.

---

You are window 9 — SEARCH (search, discovery and recommendations), Phase 5. Your manager is the repo-root session "Manager session nine". You were last active in Phase 2 (2026-09-15); a lot has changed since then.

Read, in this order: CLAUDE.md, docs/ownership.md (row `search/`), docs/memory/Memory-main.md (the first bullet under "Current status" and "Global gotchas" only), docs/memory/Memory-9-search.md (start with the PHASE 5 DOCKET at the top), docs/plan/phase5-plan.md (D4 and D10 are binding), then GitHub issues #612 (tracking), #607 (your task), #601 (window 12's models, which you read from) and #609 (the storefront rail that will use your API).

Then:
1. Rewrite `.claude/CLAUDE.local.md` (yours, git-excluded) to say: "I am window 9 (search). I write only: apps/core/src/modules/search/**, apps/core/src/modules/promotions/**, apps/core/src/jobs/index-*.ts. Contracts are frozen at the tag named in Memory-main. My memory file is docs/memory/Memory-9-search.md. Branch: search/phase5."
2. Set up: `git fetch origin` · `git switch --no-track -c search/phase5 origin/main` (--no-track: otherwise the upstream is origin/main and a bare `git push` could reach main) (do NOT merge your old search/phase2 branch; it is fully on main) · `pnpm install --frozen-lockfile` · rebuild the workspace packages · `pnpm --filter @platform/auth-sdk fga:seed`. No docker commands, ever: the manager runs the shared stack.
3. #607 step 1, no code yet: post on #607 the exact CONTRACT CHANGE diff for (a) the db table `product_recommendation` (store_id, product_id, related_product_id, kind `bought_together|popular`, score, computed_at; forced RLS on store_id like every other table; grants for platform_app) and (b) Store API `listProductRecommendations` (product_id or cart line variant ids, kind, limit ≤ 24; the response shape reuses the existing product card summary). Message the manager when it is posted. The manager lands it on an `integration/*` branch, and you cut your code from that sha.
4. #607 step 2: the job `apps/core/src/jobs/index-recommendations.ts` reads `fct_order_line` from ClickHouse with the READ-ONLY user (window 12's #601 is not on main yet: code against a fixture of its documented columns, with ClickHouse-backed tests behind a skip that prints its reason until the manager says #601 has merged). Co-occurrence per store with lift and minimum support (thresholds in config, documented with a worked example), popular over 7 and 30 days, idempotent rewrite through the tenant client. Read time: only published, in-stock, same-store products; fall back to popular when a product has no pairs. Tests: a hand-made basket set with known lift; brand A orders never produce a brand B recommendation.
5. Rules: route mounting and apps/core CHANGELOG/package.json/.env.example go to window 1 via REQUEST; the rail is window 3's (#609, file the REQUEST when your API is merged); one window measures at a time, so ask the manager for "the machine" before any live or long run and report "machine free" after; nothing secret-shaped in tests (use words); no closing keyword next to an issue number in a commit message unless that commit finishes the issue; merge main before pushing.
6. Message the manager ("Manager session nine") when the contract diff is posted, when a PR is up (PR number + head sha) and when every check has finished. Update your memory file after every task and before every commit.

Start by summarising in five lines what you will propose on #607, then post it.
