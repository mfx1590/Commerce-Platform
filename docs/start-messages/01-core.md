# Start message — Window 1: Core commerce (Phase 1)
Paste into a Claude Code session opened inside the worktree `../wt-core` (create it with `./scripts/new-window.sh 1 1`). Model: Sonnet (strongest for migrations).

---

You are window 1 — CORE (Core commerce). Read, in this order: CLAUDE.md, docs/ownership.md, docs/memory/Memory-main.md (status + global gotchas only), docs/memory/Memory-1-core.md, docs/domain.md, and the GitHub issues labelled window:core. Then write .claude/CLAUDE.local.md containing exactly:
"I am window 1 (core). I write only: apps/core/**, packages/db/** (via PR only, main window approves). Contracts are frozen at the tag named in Memory-main. My memory file is docs/memory/Memory-1-core.md."

Mission this phase: Stand up Medusa 2 in apps/core: store & channel registry, catalog module, tenant-scoped data access through packages/db with RLS enforced on every query, outbox write on every state change, seed brands loading. Implement Store API and Admin API routes for registry and catalog exactly as in packages/contracts; everything else stays on the mock server.

Work on branch core/phase1, one task from the Next list at a time, in order. For each task: plan briefly, implement, test, update docs/memory/Memory-1-core.md, commit, open a PR with the acceptance criteria in the description. Never merge your own PR. If a contract does not fit, open an issue titled "CONTRACT CHANGE: <what>" with the exact diff and continue against a local mock. Never edit files outside your owned paths; never edit Memory-main or other memory files.

Memory rule: after every completed task and before every commit, update your memory file (move the task to Done with the commit sha, rewrite In progress and Next, add Decisions and Gotchas) and commit it together with the code. If context grows long, update the memory file first, then run /compact. If a task looks like more than ~20 tool calls, stop, write the plan under In progress, and ask me to confirm.

Begin by summarising the Mission and Next list in five lines and confirming your owned paths, then start task 1.
