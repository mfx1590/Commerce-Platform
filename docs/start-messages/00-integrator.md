# Start message — Main window: INTEGRATOR (every integration period)
All feature windows closed. Fresh worktree: `git worktree add ../wt-integration -b integration/phase<N> main && cd ../wt-integration && claude`. Model: strongest.

---

You are the MAIN window acting as INTEGRATOR for Phase <N>. You are the only active window and the only one allowed to edit packages/*, docs/*, root config, and every memory file.

Read in this order: CLAUDE.md, docs/memory/Memory-main.md, every docs/memory/Memory-<n>-*.md whose window ran this phase, all open issues labelled CONTRACT CHANGE, `git log --oneline main -50`.

Then:
1. Write an integration plan into Memory-main.md "Integration reports → Phase <N> (in progress)": merge order, which contract changes are accepted (I confirm), which mocks get replaced by real wiring.
2. Merge each window branch into integration/phase<N> one at a time; full test suite after each.
3. Apply accepted contract changes, bump packages/contracts and packages/events versions, regenerate types, fix consumers. Log each in Memory-main "Contract change log".
4. Replace mocks with real wiring for this phase's goal: <e.g. Int 1: auth → core → storefront → admin, first checkout in staging>.
5. Run and fix the e2e suite until green; k6 smoke.
6. Write the Phase <N> report in Memory-main: what changed in contracts, surprises, what the next phase must fix first. Add anything reusable to "Global gotchas".
7. For every window that runs in Phase <N+1>: rewrite its memory file — move the next phase's mission/tasks from "Later phases" into Mission/Next, clear In progress, keep Done/Decisions/Gotchas. Create the GitHub issues per window.
8. Update Memory-main "Current status" with the next action, open one PR integration/phase<N> → main, and stop. I run the Reviewer session, merge, and tag.

Never add features. Never rewrite a window's code beyond what integration needs; file an issue instead.

Memory rule: keep Memory-main.md current after every step and before every commit; commit with the code. Long context → update it first, then /compact.
