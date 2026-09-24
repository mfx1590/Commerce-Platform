# marketing module (apps/core)

## Purpose

Campaigns and the attribution report, product feeds (render + store), segments with the frozen rule grammar and
the window 16 sync payload, abandoned-cart recovery and its report. Every reported number comes from `attribution`
rows and orders — never from a pixel. Full design and decisions: `README.md` (read it; do not re-explore).

## Owner

window 17 (marketing), branch prefix `marketing/`. Also owns `apps/feeds/**` and the admin section under
`apps/admin/src/app/(store)/[storeId]/marketing/**` + `(hq)/marketing/**` (+ `apps/admin/test{,-contract}/marketing`).
Mounting (`src/http/module-routers.ts`) and the Store API recovery route are window 1's.

## Run / test

- `pnpm --filter @platform/core exec vitest run src/modules/marketing` — ~15 s, own throwaway databases.
- Start with `marketing.e2e.test.ts`: the whole flow on one database + the PII sweep.
- Gates: `pnpm lint && pnpm typecheck && pnpm test --filter @platform/core --filter @platform/feeds --filter @platform/admin`.
- `turbo` strips `DATABASE_URL*`; call vitest directly when the host has to be pinned to 127.0.0.1.

## Public API

`index.ts` only — services take a store-scoped `ScopedClient`; `marketingAdminRouter()` carries every Admin API
route. `SEGMENT_RULES_SCHEMA`, `segmentSyncPayload`/`emailHash` (window 16), `validateRecoveryToken` (window 1)
and `RECOVERY_UTM_SOURCE` (windows 3/10/16) are the cross-window surface. Nothing imports any other file here.

## Constraints

- Never mutate orders, prices or stock. The only write outside marketing's own tables is `cart.status`
  `abandoned → active` on a redeemed recovery link (README, "The one rule").
- State changes with an event go through `withEvents` in the same transaction. Event payloads, audit rows and
  the sync payload carry ids, amounts, utm strings and `email_hash` — never email, name, phone or address.
  **No log calls in this module**; a static test enforces it.
- Feed renderers are deterministic (no timestamps, stable order): publish idempotency is the stored artifact's hash.
- The segment grammar is closed: an unknown field/op is a 400, never ignored. Negated predicates over nullable
  columns use `IS DISTINCT FROM`.
- Recovery tokens are stored as sha256 only; single use is `UPDATE … WHERE redeemed_at IS NULL`.
- Update `README.md` and `CHANGELOG.md` with every change.

## Gotchas

- node-postgres returns `bigint`/`sum()` as strings: `::text` in SQL, `Number()` in TypeScript.
- Event payload optional fields `$ref` definitions that reject `null` — omit them instead.
- `app.set_updated_at` fires BEFORE UPDATE: back-date rows in the INSERT, never with an UPDATE.
- Never CHECK an app-supplied timestamp against a database `now()` default (clock skew).
- Organization templates are visible only in organization scope (`store_nullable` RLS) — inject the client.
- Known gap: `getPromotionReport` is in the contract but has no route here yet (README, "Known gap").
