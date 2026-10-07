# Changelog — @platform/notifications

## 0.2.1 — 2026-10-07 (window 17, Refs #360)

- `notification_delivery` is now the real migration (packages/db 0180, db 0.3.3, #393 landed in #397); the
  proposed copy and the test-side apply were removed in that landing. README, CLAUDE.md and the package `files`
  list say so.
- `errorLabel` is label-only everywhere (#396 review nit): a `TransportError` as built, any other error by its
  name only — a database or filesystem message never reaches `last_error` or a log line.

## 0.2.0 — 2026-10-07 (window 17, Refs #360)

- The scaffold becomes the transactional email worker: an outbox consumer for `order.placed` and
  `shipment.shipped` (poll per store, cursor in `marketing_cursor`), one email per event **exactly once** —
  `notification_delivery` keyed `UNIQUE (event_id)` (proposed migration `migrations/0180_notification_delivery.sql`,
  CONTRACT CHANGE to the main window), claim in one transaction, deliver after the commit, bounded retries,
  stuck rows reported and never resent, a clock-free lookback below the cursor.
- `Transport` interface with two implementations: `DevSinkTransport` (files under `NOTIFICATIONS_DIR`, PII-free
  log line) and `ResendTransport` (built-in `fetch`, `RESEND_API_KEY` from the environment only, idempotency key
  per event; the live send is the 2b gate).
- Templates for brand A in en-GB and de-DE: order confirmation and shipping notice, rendered from the database
  rows (never the payload), money by `Intl` from minor units, dates in the store timezone, escaped HTML, legal
  footer from `legal_entity` plus environment-overridable placeholders.
- HTTP: `GET /health` (last run's counts) and the staff-only preview `GET /preview/{order-confirmation|
shipment-shipped}?store=&locale=` on sample data (staff JWT via `@platform/auth-sdk`, or `dev:` tokens with
  `NOTIFICATIONS_DEV_TOKENS=1` outside production; subject must be an active `staff_user`).
- `start`/`once`/`dev` scripts (the image switches from the scaffold health server to the worker by itself);
  production refuses a missing store list, the dev sink and dev tokens at boot.
- Tests: templates, transports + config, server, and the consumer on a seeded throwaway database with a PII
  sweep over every log line. Ownership: `apps/notifications/**` moved to window 17 on main (13c393d).

## 0.1.0 — 2026-09-04

- Scaffold created by the main window (Phase 0).
