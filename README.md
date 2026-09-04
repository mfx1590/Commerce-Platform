# commerce-platform — starter kit

Everything Claude Code needs to build the multi-brand commerce platform, one window at a time.

## Start (you, once)

1. Fill `docs/decisions.md` (no `<DECIDE>` left). Mirror into `docs/memory/Memory-main.md`.
2. `git init && git add -A && git commit -m "kit" && gh repo create <org>/commerce-platform --private --source=. --push`
3. Protect `main` (PR required, CI green). Install: `npm i -g @anthropic-ai/claude-code`, `gh auth login`.
4. In the repo root: `claude` → paste `docs/start-messages/00-main-architect.md`. This is the MAIN window (Phase 0).
5. When it says done: `git tag contracts-v0.1 && git push --tags`.

## Local development (after Phase 0)
```
pnpm install && pnpm dev     # docker compose (Postgres 5433, Redis 6381, Redpanda, Keycloak 8180, OpenFGA 8081, mocks 4010/4011) + migrate + seed
pnpm lint && pnpm typecheck && pnpm test && pnpm test:contract
```
Contracts: `packages/contracts/openapi/*.yaml` · events: `packages/events/schemas` · schema: `packages/db/migrations` · entities: `docs/domain.md` · ADRs: `docs/adr/`.

## Each window afterwards

```
./scripts/new-window.sh 1 1      # window 1 (core), phase 1 → creates ../wt-core
cd ../wt-core && claude          # paste docs/start-messages/01-core.md
```

New day / context reset in the same worktree: `claude` → `/resume` (or paste `docs/start-messages/00-resume-any-window.md`).
Before merging a PR: `claude` in repo root → `/review <PR number>`.
Integration period: `git worktree add ../wt-integration -b integration/phase<N> main` → paste `docs/start-messages/00-integrator.md`.

## Where things are

- `docs/memory/Memory-main.md` — whole-project state, phase plan, window index (main window owns it)
- `docs/memory/Memory-<n>-<key>.md` — one memory per window; the window owns it
- `docs/start-messages/` — paste-ready kickoff for main, integrator, reviewer, resume, and windows 1–16
- `docs/ownership.md` — who may write where; `scripts/check-ownership.sh` enforces it in CI
- `docs/plan/` — master plan, diagrams, owner playbook, solo Max 5x schedule
- `.claude/commands/` — `/resume`, `/save`, `/review`, `/contract-change`

Generated 2026-09-04.
