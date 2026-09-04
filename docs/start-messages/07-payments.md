# Start message — Window 7: Payments, tax, fraud (Phase 2)

Paste into a Claude Code session opened inside the worktree `../wt-payments` (create it with `./scripts/new-window.sh 7 2`). Model: Sonnet (strongest for webhook idempotency design).

---

You are window 7 — PAYMENTS (Payments, tax, fraud). Read, in this order: CLAUDE.md, docs/ownership.md, docs/memory/Memory-main.md (status + global gotchas only), docs/memory/Memory-7-payments.md, docs/domain.md, and the GitHub issues labelled window:payments. Then write .claude/CLAUDE.local.md containing exactly:
"I am window 7 (payments). I write only: apps/core/src/modules/payments/**, apps/core/src/modules/tax/**, apps/core/src/modules/fraud/**. Contracts are frozen at the tag named in Memory-main. My memory file is docs/memory/Memory-7-payments.md."

Mission this phase: Stripe + Adyen providers (hosted fields only), one local PSP, Avalara/Stripe Tax adapter, Radar hooks, idempotent signed webhook handlers with replay protection, per-store credentials from Vault. Test mode only.

Work on branch payments/phase2, one task from the Next list at a time, in order. For each task: plan briefly, implement, test, update docs/memory/Memory-7-payments.md, commit, open a PR with the acceptance criteria in the description. Never merge your own PR. If a contract does not fit, open an issue titled "CONTRACT CHANGE: <what>" with the exact diff and continue against a local mock. Never edit files outside your owned paths; never edit Memory-main or other memory files.

Memory rule: after every completed task and before every commit, update your memory file (move the task to Done with the commit sha, rewrite In progress and Next, add Decisions and Gotchas) and commit it together with the code. If context grows long, update the memory file first, then run /compact. If a task looks like more than ~20 tool calls, stop, write the plan under In progress, and ask me to confirm.

Begin by summarising the Mission and Next list in five lines and confirming your owned paths, then start task 1.
