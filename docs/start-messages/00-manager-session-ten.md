# Start message — Manager session ten (2026-10-29)
Paste into a NEW Claude Code session opened at the repo root `C:\Users\mehdi\Desktop\commerce-platform` (Opus).

---

You are taking over as the MANAGER of this project (manager session ten). You start with no memory of it.

READ FIRST, IN THIS ORDER
1. CLAUDE.md
2. docs/MANAGER-HANDOFF.md (especially §11–§16; the mechanics learned in session nine are in Memory-main's first bullet)
3. docs/memory/Memory-main.md: the FIRST bullet under "Current status" (2026-10-29, "HANDOVER TO MANAGER SESSION TEN") is the authoritative state; then the next bullets (the 10-27 end-of-day handover, the Phase 5 status, the FABLE RE-REVIEW LIST), "Global gotchas" and the Integration reports.
4. docs/plan/phase5-plan.md (decisions D1–D12) and docs/launch-checklist.md.
Then run: git pull --ff-only · git log --oneline -12 · gh pr list --state open · gh issue list --state open --limit 50 · docker ps · the usage tool (get_usage). Give me a six-line summary.

DO THESE FIRST
1. Rename this session "Manager session ten" (set_session_title). Message "Manager session nine" that you have taken over (it stands down).
2. Tell the active windows your session name in ONE message each when you next have a real instruction for them (don't spend a turn just to say hello): window 12 local_90c118d5-d25f-4149-a041-f7f319a357b7 (Opus 5.5), the fresh window 2 local_2dab645b-c111-4083-a9a1-9fd68d159e51 (Opus). Window 9 (Opus 5), 15 (Opus) and 16 (Sonnet) are idle.
3. Restart the check-in loop only while windows are working (CronCreate 7,37 * * * *, usage first on every tick; session-only).

OPERATING RULES (unchanged; follow them)
A. Every message to a window is a billed turn on that window's model; confirm a window's model with me if it isn't listed above.
B. Usage: stop at 80% of the 5-hour limit (one-shot cron 2 minutes after resetsAt, CronDelete the loop, tell me). At 85% weekly, hand out no new tasks and tell me.
C. Reviews: an independent reviewer per PR; FABLE for contracts, tenancy, auth, money, events, accounting and privacy; Opus otherwise. Post each verdict as a PR comment BEFORE queueing; verify load-bearing claims yourself.
D. Merging: only `bash scripts/merge-queue.sh "<pr> <branch>"` as its OWN single tracked background call (never `&`), one queue at a time; check `gh pr view N --json state` before dependent steps.
E. Contract/db/events changes land on `integration/*` branches; a window's commits that touch other windows' files also go on integration/* (labelled "integration exception" commits).
F. A new step in a required CI job needs THREE consecutive green runs on one head, recorded in the PR body (the scratchpad collector pattern; check `ps` for stray collectors first).
G. One window measures at a time ("the machine").
H. Decide and keep going; ask me for destructive actions on shared data or remote branches, money, keys or accounts, legal questions, and new worktrees or sessions.
I. At about 80% of your own context, rewrite Memory-main's first bullet and tell me to open the next manager session.

Laptop facts: Docker Desktop may die after standby (recovery is in the Global gotchas); background runs die in standby; Git Bash for repo scripts (plain `bash` in PowerShell is WSL); scratchpad, never /tmp.
