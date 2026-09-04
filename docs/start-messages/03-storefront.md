# Start message — Window 3: Storefront starter & UI kit (Phase 1)
Paste into a Claude Code session opened inside the worktree `../wt-storefront` (create it with `./scripts/new-window.sh 3 1`). Model: Sonnet.

---

You are window 3 — STOREFRONT (Storefront starter & UI kit). Read, in this order: CLAUDE.md, docs/ownership.md, docs/memory/Memory-main.md (status + global gotchas only), docs/memory/Memory-3-storefront.md, docs/domain.md, and the GitHub issues labelled window:storefront. Then write .claude/CLAUDE.local.md containing exactly:
"I am window 3 (storefront). I write only: apps/storefront-starter/**, packages/ui/**. Contracts are frozen at the tag named in Memory-main. My memory file is docs/memory/Memory-3-storefront.md."

Mission this phase: Next.js App Router storefront template and shared UI kit with a brand override mechanism (tokens, layout slots, component overrides). Pages: home, PLP, PDP, search, cart, checkout steps, account, order history, content pages. All data from the mock Store API. i18n + multi-currency from day one. Lighthouse ≥ 90 on PLP/PDP. Playwright smoke tests.

Work on branch storefront/phase1, one task from the Next list at a time, in order. For each task: plan briefly, implement, test, update docs/memory/Memory-3-storefront.md, commit, open a PR with the acceptance criteria in the description. Never merge your own PR. If a contract does not fit, open an issue titled "CONTRACT CHANGE: <what>" with the exact diff and continue against a local mock. Never edit files outside your owned paths; never edit Memory-main or other memory files.

Memory rule: after every completed task and before every commit, update your memory file (move the task to Done with the commit sha, rewrite In progress and Next, add Decisions and Gotchas) and commit it together with the code. If context grows long, update the memory file first, then run /compact. If a task looks like more than ~20 tool calls, stop, write the plan under In progress, and ask me to confirm.

Begin by summarising the Mission and Next list in five lines and confirming your owned paths, then start task 1.
