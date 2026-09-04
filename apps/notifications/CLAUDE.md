# @platform/notifications

## Purpose

Novu worker (Phase 4): turns events into email/SMS/WhatsApp/Slack notifications per brand. Scaffold only.

## Owner

window 16 (engagement).

## Run / test

- `pnpm --filter @platform/notifications build` — compile to dist/
- `pnpm --filter @platform/notifications typecheck`
- `pnpm --filter @platform/notifications test` — Vitest (tests live in test/)
- Root: `pnpm lint && pnpm typecheck && pnpm test --filter @platform/notifications` before finishing any task.

## Public API

- Consumer group: notifications.all; templates per store in templates/<store>/

## Constraints

- Import other packages only through their public API (`@platform/<name>`), never `src/*`.
- No secrets in code. No PII in logs. Every DB access through `@platform/db` tenant client.
- Update README.md and CHANGELOG.md with every change.

## Phase 0 note

This is a scaffold: package.json, tsconfig, an empty index.ts. The owning window replaces it with the real
framework setup (Medusa 2 / Next.js) in its first Phase 1 task. Keep the package name and the CLAUDE.md sections.
