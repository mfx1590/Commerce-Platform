# Resume message (any window, after a context reset or a new day)
Paste into a new Claude Code session opened in the same worktree.

---

You are window <n> (<key>). Read, in this order: CLAUDE.md, .claude/CLAUDE.local.md, docs/memory/Memory-<n>-<key>.md, then `git log --oneline -20` and `git status`. Summarise in five lines where the previous session stopped. Continue with the first item under "In progress" (or the first unchecked item under "Next" if In progress is empty). Do not redo anything under Done. Keep the memory rule: update the memory file after every task and before every commit; /compact after updating when context is long.
