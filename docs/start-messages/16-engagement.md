# Start message — Window 16: CRM, notifications & support (Phase 4)
Paste into a Claude Code session opened inside the worktree `../wt-engagement` (create it with `./scripts/new-window.sh 16 4`). Model: Sonnet.

(2026-10-23: the owned paths are apps/engagement/**, apps/support/**, data/cdp/** — apps/notifications stays with window 17. The manager's start message overrides this file where they differ.)

---

You are window 16 — ENGAGEMENT (CRM, notifications & support). Read, in this order: CLAUDE.md, docs/ownership.md, docs/memory/Memory-main.md (status + global gotchas only), docs/memory/Memory-16-engagement.md, docs/domain.md, and the GitHub issues labelled window:engagement. Then write .claude/CLAUDE.local.md containing exactly:
"I am window 16 (engagement). I write only: apps/engagement/**, apps/support/**, data/cdp/**. Contracts are frozen at the tag named in Memory-main. My memory file is docs/memory/Memory-16-engagement.md."

Mission this phase: bus consumers in apps/engagement — ops alerts to Slack, a CDP tracking plan + RudderStack mapper, CRM sync (Twenty), a support-context API — each an adapter with a mock (issues #553–#556).

Work on branch engagement/phase4, one task from the Next list at a time, in order. For each task: plan briefly, implement, test, update docs/memory/Memory-16-engagement.md, commit, open a PR with the acceptance criteria in the description. Never merge your own PR. If a contract does not fit, open an issue titled "CONTRACT CHANGE: <what>" with the exact diff and continue against a local mock. Never edit files outside your owned paths; never edit Memory-main or other memory files.

Memory rule: after every completed task and before every commit, update your memory file (move the task to Done with the commit sha, rewrite In progress and Next, add Decisions and Gotchas) and commit it together with the code. If context grows long, update the memory file first, then run /compact. If a task looks like more than ~20 tool calls, stop, write the plan under In progress, and ask me to confirm.

Begin by summarising the Mission and Next list in five lines and confirming your owned paths, then start task 1.
