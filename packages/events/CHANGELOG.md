# Changelog — @platform/events

## 0.1.0 — 2026-09-04

- Scaffold created by the main window (Phase 0).

## 0.1.0 — 2026-09-04 (Phase 0 step 5)

- 24 event schemas v1 (JSON Schema 2020-12) + common $defs + envelope; `additionalProperties: false` everywhere; no PII fields.
- `scripts/generate.mjs` → `src/generated/{schemas,types}.ts` (json-schema-to-typescript); committed.
- `createValidator`, `makeEvent`, `toOutboxRow`; `migrations/0100_outbox.sql` (outbox table + RLS, applied by packages/db).
