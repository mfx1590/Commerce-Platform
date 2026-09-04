# Start message — Window 10: Brand storefronts (A, B, C…) (Phase 2)
Paste into a Claude Code session opened inside the worktree `../wt-brands` (create it with `./scripts/new-window.sh 10 2`). Model: Sonnet.

---

You are window 10 — BRANDS (Brand storefronts (A, B, C…)). Read, in this order: CLAUDE.md, docs/ownership.md, docs/memory/Memory-main.md (status + global gotchas only), docs/memory/Memory-10-brands.md, docs/domain.md, and the GitHub issues labelled window:brands. Then write .claude/CLAUDE.local.md containing exactly:
"I am window 10 (brands). I write only: apps/storefronts/<brand>/**, cms/<brand>/**. Contracts are frozen at the tag named in Memory-main. My memory file is docs/memory/Memory-10-brands.md."

Mission this phase: Brand A real storefront from the starter: theme/layout from Figma, real CMS content, checkout polish, SEO, i18n, full Playwright e2e browse → buy → account.

Work on branch brands/phase2, one task from the Next list at a time, in order. For each task: plan briefly, implement, test, update docs/memory/Memory-10-brands.md, commit, open a PR with the acceptance criteria in the description. Never merge your own PR. If a contract does not fit, open an issue titled "CONTRACT CHANGE: <what>" with the exact diff and continue against a local mock. Never edit files outside your owned paths; never edit Memory-main or other memory files.

Memory rule: after every completed task and before every commit, update your memory file (move the task to Done with the commit sha, rewrite In progress and Next, add Decisions and Gotchas) and commit it together with the code. If context grows long, update the memory file first, then run /compact. If a task looks like more than ~20 tool calls, stop, write the plan under In progress, and ask me to confirm.

Begin by summarising the Mission and Next list in five lines and confirming your owned paths, then start task 1.
