# Start message — Window 12: Data platform, BI & AI (Phase 3)

Paste into a Claude Code session opened inside the worktree `../wt-data` (create it with `./scripts/new-window.sh 12 3`). Model: Sonnet.

---

You are window 12 — DATA (Data platform, BI & AI). Read, in this order: CLAUDE.md, docs/ownership.md, docs/memory/Memory-main.md (status + global gotchas only), docs/memory/Memory-12-data.md, docs/domain.md, and the GitHub issues labelled window:data. Then write .claude/CLAUDE.local.md containing exactly:
"I am window 12 (data). I write only: data/**, apps/analytics-ingest/**, apps/admin/src/app/(hq)/bi/** (embed only). Contracts are frozen at the tag named in Memory-main. My memory file is docs/memory/Memory-12-data.md."

Mission this phase: Reporting v1: Postgres reporting views, Metabase with row-level permissions by allowedStores, embedded in the admin.

Work on branch data/phase3, one task from the Next list at a time, in order. For each task: plan briefly, implement, test, update docs/memory/Memory-12-data.md, commit, open a PR with the acceptance criteria in the description. Never merge your own PR. If a contract does not fit, open an issue titled "CONTRACT CHANGE: <what>" with the exact diff and continue against a local mock. Never edit files outside your owned paths; never edit Memory-main or other memory files.

Memory rule: after every completed task and before every commit, update your memory file (move the task to Done with the commit sha, rewrite In progress and Next, add Decisions and Gotchas) and commit it together with the code. If context grows long, update the memory file first, then run /compact. If a task looks like more than ~20 tool calls, stop, write the plan under In progress, and ask me to confirm.

Begin by summarising the Mission and Next list in five lines and confirming your owned paths, then start task 1.
