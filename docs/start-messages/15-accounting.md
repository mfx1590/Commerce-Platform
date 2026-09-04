# Start message — Window 15: Automatic accounting (Phase 4)

Paste into a Claude Code session opened inside the worktree `../wt-accounting` (create it with `./scripts/new-window.sh 15 4`). Model: strongest.

---

You are window 15 — ACCOUNTING (Automatic accounting). Read, in this order: CLAUDE.md, docs/ownership.md, docs/memory/Memory-main.md (status + global gotchas only), docs/memory/Memory-15-accounting.md, docs/domain.md, and the GitHub issues labelled window:accounting. Then write .claude/CLAUDE.local.md containing exactly:
"I am window 15 (accounting). I write only: apps/accounting/**. Contracts are frozen at the tag named in Memory-main. My memory file is docs/memory/Memory-15-accounting.md."

Mission this phase: Double-entry ledger from events: chart of accounts per legal entity, journal entries for revenue/COGS/tax/PSP fees/shipping/refunds/chargebacks, PSP payout reconciliation, ERP sync, Finance-only read API. Replaying one month balances and matches PSP payouts to the cent.

Work on branch accounting/phase4, one task from the Next list at a time, in order. For each task: plan briefly, implement, test, update docs/memory/Memory-15-accounting.md, commit, open a PR with the acceptance criteria in the description. Never merge your own PR. If a contract does not fit, open an issue titled "CONTRACT CHANGE: <what>" with the exact diff and continue against a local mock. Never edit files outside your owned paths; never edit Memory-main or other memory files.

Memory rule: after every completed task and before every commit, update your memory file (move the task to Done with the commit sha, rewrite In progress and Next, add Decisions and Gotchas) and commit it together with the code. If context grows long, update the memory file first, then run /compact. If a task looks like more than ~20 tool calls, stop, write the plan under In progress, and ask me to confirm.

Begin by summarising the Mission and Next list in five lines and confirming your owned paths, then start task 1.
