# @platform/notifications

## Purpose

Transactional email worker (#360): consumes `order.placed` and `shipment.shipped` from the outbox table and
sends one email per event, exactly once, through a transport (`dev` sink or Resend). Templates per brand and
locale (brand A: en-GB, de-DE), a staff-only preview route, `GET /health`. README.md has the design.

## Owner

window 17 (marketing), since 2026-10-07 (docs/ownership.md). Before that: a Phase 0 scaffold reserved for
window 16's Phase 4 Novu worker — that scope (SMS/WhatsApp/Slack, consumer groups) is not here.

## Run / test

- `pnpm --filter @platform/notifications dev` — the worker with the dev sink against `.env` (DB rows on 127.0.0.1)
- `pnpm --filter @platform/notifications once` — one pass, prints the report, exits
- `pnpm --filter @platform/notifications build` / `typecheck` (src and tests) / `lint`
- `pnpm --filter @platform/notifications exec vitest run` — ~8 s; `consumer.test.ts` builds its own throwaway DB
  through `@platform/db/testing` (`notification_delivery` = packages/db migration 0180, db 0.3.3)
- Root: `pnpm lint && pnpm typecheck && pnpm test --filter @platform/notifications` before finishing any task.

## Layout

- `src/consumer.ts` — claim (one transaction) + deliver (after commit); the exactly-once rules
- `src/render-data.ts` — the database reads an email is rendered from (never the payload)
- `src/templates/` — `strings.ts` (all copy per locale), `layout.ts`, one file per kind, `fixtures.ts` (preview)
- `src/brands.ts` — sender / legal footer per store code, env overrides `NOTIFICATIONS_<STORE>_<FIELD>`
- `src/transport/` — `Transport` implementations: `dev-sink.ts`, `resend.ts`
- `src/auth.ts`, `src/server.ts` — staff auth + `/health` + `/preview/*`; `src/config.ts`, `src/main.ts`

## Public API

`src/index.ts`: `runOnce` / `claimEvents` / `deliverPending` / `resolveStores`, `render` / `pickLocale` /
`fixtureFor`, `brandProfile` / `applyLegalEntity`, the transports, `createStaffAuth`,
`createNotificationsServer`, `resolveConfig`, and the types. Nothing imports this package yet.

## Constraints

- Import other packages only through their public API (`@platform/<name>`), never `src/*`.
- No secrets in code; `RESEND_API_KEY` is read from the environment only and never logged or stored.
- **No PII in logs or rows.** The recipient's address exists in `RenderedEmail.to` only; log lines and
  `last_error` carry event id, kind, store, locale, display id. The consumer test sweeps every log line.
- Every DB access through `@platform/db`'s scoped client (organization scope; RLS applies).
- Never resend a stuck row (attempted, no outcome) automatically — a duplicate confirmation is worse than one
  the owner has to look at.
- Templates render from the database rows, never from the event payload.
- Update README.md and CHANGELOG.md with every change.
