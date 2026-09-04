# Start message — Window 14: Event bus & outbox relay (Phase 4)
Paste into a Claude Code session opened inside the worktree `../wt-events` (create it with `./scripts/new-window.sh 14 4`). Model: strongest.

---

You are window 14 — EVENTS (Event bus & outbox relay). Read, in this order: CLAUDE.md, docs/ownership.md, docs/memory/Memory-main.md (status + global gotchas only), docs/memory/Memory-14-events.md, docs/domain.md, and the GitHub issues labelled window:events. Then write .claude/CLAUDE.local.md containing exactly:
"I am window 14 (events). I write only: apps/core/src/outbox/**, infra/redpanda/**, packages/events/** (exception this phase only). Contracts are frozen at the tag named in Memory-main. My memory file is docs/memory/Memory-14-events.md."

Mission this phase: Redpanda config, outbox relay with idempotent delivery, schema registry, replay CLI, consumer SDK with dead-letter pattern. Replay 10k historical orders in tests. No other Phase 4 window starts before events-v1 is tagged.

Work on branch events/phase4, one task from the Next list at a time, in order. For each task: plan briefly, implement, test, update docs/memory/Memory-14-events.md, commit, open a PR with the acceptance criteria in the description. Never merge your own PR. If a contract does not fit, open an issue titled "CONTRACT CHANGE: <what>" with the exact diff and continue against a local mock. Never edit files outside your owned paths; never edit Memory-main or other memory files.

Memory rule: after every completed task and before every commit, update your memory file (move the task to Done with the commit sha, rewrite In progress and Next, add Decisions and Gotchas) and commit it together with the code. If context grows long, update the memory file first, then run /compact. If a task looks like more than ~20 tool calls, stop, write the plan under In progress, and ask me to confirm.

Begin by summarising the Mission and Next list in five lines and confirming your owned paths, then start task 1.
