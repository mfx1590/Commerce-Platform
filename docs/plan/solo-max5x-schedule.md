# Running this solo on Claude Max 5x

## Concurrency
- ONE build window active at a time (Sonnet for implementation).
- A Reviewer session (docs/start-messages/00-reviewer.md) opened only to review PRs, then closed.
- Main window (Architect in Phase 0, Integrator in every Int period) uses the strongest model, alone.
- Windows 14 events and 15 accounting also use the strongest model.
- Claude Code, Claude chat and Cowork share one usage pool; avoid heavy chat on build days.

## Phase 1 sequence
| Weeks | Window | Model | Goal |
|---|---|---|---|
| 1–3 | main (Architect) | strongest | contracts-v0.1 |
| 4–5 | 1 core | Sonnet | registry + catalog, RLS, outbox, seeds |
| 6 | 2 auth | Sonnet (+1 day strongest for the OpenFGA model) | Keycloak, OpenFGA, scope, audit |
| 7–8 | 3 storefront | Sonnet | starter + UI kit vs mock |
| 9–10 | 4 admin | Sonnet | shell, permission nav, screens vs mock |
| 11 | main (Integrator) | strongest | first checkout end to end |
Infra (5) and CMS (6) start in Phase 2; until then: Vercel + docker-compose + Sentry.

## Week
- Mon–Thu morning: current build window, one task to done, memory updated, PR opened (2–3 tasks per session).
- After the 5-hour reset: Reviewer session per PR (5 min), merge, close. If budget allows, one more task.
- Friday: no features. Read the memory file, tidy, write next week's issues, /compact.
- Check `/usage` before big tasks. Past ~60% weekly by Wednesday → docs/tests only until reset.

## Budget savers
1. Plan mode first (cheap), confirm, then execute.
2. Package CLAUDE.md holds run/test commands and API shape so windows never re-explore.
3. Long test output → file; read only failures. Never paste big logs into chat.

## Expectation
Brand 1 live around month 6–8. The cheapest speed-up is Max 20x (two real build windows), not a second account.
