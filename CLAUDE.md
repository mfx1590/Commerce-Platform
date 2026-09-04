# Project rules — read before every task

## Identity

- Your window identity is in `.claude/CLAUDE.local.md` (created by scripts/new-window.sh or by your start message). If it is missing you are the MAIN window on the repo root.
- Your memory file is `docs/memory/Memory-<n>-<key>.md` (windows) or `docs/memory/Memory-main.md` (main window). Read it at the start of every session.

## Ownership (enforced in CI by scripts/check-ownership.sh)

- Write ONLY inside the paths listed for your branch prefix in `docs/ownership.md`. Read anything.
- `packages/contracts`, `packages/events`, `packages/db` schema, `docs/**`, root config: main window / integration branches only.
- Need a change elsewhere? Open a GitHub issue titled `CONTRACT CHANGE: <what>` (exact diff) or `REQUEST: <what>`, then continue against a local mock. Never edit it yourself.
- Do not refactor code you do not own, even if it looks wrong. File an issue.

## Memory

- After every completed task and before every commit: update your memory file (Done with commit sha, In progress, Next, Decisions, Gotchas). Commit it together with the code.
- Context getting long: update the memory file first, then run /compact. Prefer /compact after every finished task.
- Never edit another window's memory file. Only the main window edits Memory-main.md.

## Engineering rules

- Every row has `store_id` (or `organization_id`). Every query goes through the tenant-scoped client in packages/db. Never bypass RLS.
- Every state change in apps/core writes to the outbox table in the same transaction. Never publish to the bus directly.
- Permissions are checked server-side with packages/auth-sdk on every mutating route; UI gating is a convenience, not security.
- Card data never touches our servers (hosted fields only). Secrets come from env/Vault. Never commit keys. Never log PII.
- Every module exposes index.ts (public API), README.md, tests. No cross-module imports except through public APIs and packages/*.
- Before finishing a task: `pnpm lint && pnpm typecheck && pnpm test --filter <your-package>`. Update your package README and CHANGELOG.

## Git

- Branch `<key>/phase<N>`. Small commits. One task → one PR with acceptance criteria in the description. Never merge your own PR; the Reviewer session decides.
- Never force-push, never deploy, never touch production credentials.

## Budget (solo operator, Claude Max 5x)

- One build window active at a time. If a task looks like more than ~20 tool calls, stop, write the plan into the memory file's In progress section, and ask for confirmation.
- Do not re-explore the repo for things already written in a package CLAUDE.md; read that file instead.
