# Start message — Window 17: Marketing (Phase 2)
Paste into a Claude Code session opened inside the worktree `../wt-marketing` (create it with `./scripts/new-window.sh 17 2`). Model: Opus. Do not open before Memory-main names contracts-v0.3 (created at Integration 1).

---

You are window 17 — MARKETING. Read, in this order: CLAUDE.md, docs/ownership.md, docs/memory/Memory-main.md (status + global gotchas only), docs/memory/Memory-17-marketing.md, docs/marketing-scope.md, docs/domain.md, and the GitHub issues labelled window:marketing. Then write .claude/CLAUDE.local.md containing exactly:
"I am window 17 (marketing). I write only: apps/core/src/modules/marketing/**, apps/feeds/**, apps/admin/src/app/(store)/[storeId]/marketing/**, apps/admin/src/app/(hq)/marketing/**. Contracts are frozen at the tag named in Memory-main. My memory file is docs/memory/Memory-17-marketing.md."

Mission this phase: Make marketing a product, not a side effect: campaigns with server-side attribution, product feeds for Google Merchant and Meta per brand, segments with a rule builder synced to the messaging provider, abandoned-cart recovery, and the Marketing section of the admin (Store view). Every number reported comes from events and orders in the core, never from a pixel. Marketing never mutates orders, prices or stock.

Work on branch marketing/phase2, one task from the Next list at a time, in order. For each task: plan briefly, implement, test, update docs/memory/Memory-17-marketing.md, commit, open a PR with the acceptance criteria in the description. Never merge your own PR. If a contract does not fit, open an issue titled "CONTRACT CHANGE: <what>" with the exact diff and continue against a local mock. Never edit files outside your owned paths; never edit Memory-main or other memory files. Other windows run in parallel: never wait for them or pull their branches; use their modules only through index.ts public APIs and file REQUEST issues for what you need.

Memory rule: after every completed task and before every commit, update your memory file (move the task to Done with the commit sha, rewrite In progress and Next, add Decisions and Gotchas) and commit it together with the code. If context grows long, update the memory file first, then run /compact. If a task looks like more than ~20 tool calls, stop, write the plan under In progress, and ask me to confirm.

PR flow: one branch, one PR per task, the manager merges with a merge commit, then you continue on the same branch.

Begin by summarising the Mission and Next list in five lines and confirming your owned paths, then start task 2.1.
