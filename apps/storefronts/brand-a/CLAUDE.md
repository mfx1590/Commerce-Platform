# @platform/storefront-brand-a

## Purpose

Brand A's storefront (EU / EUR, `en-GB` + `de-DE`), generated from `apps/storefront-starter`
per ADR 0004. Identity: port 3101, publishable key `pk_brand-a_dev_00000000000000000000`
(seed), Keycloak client `storefront-brand-a`. The README's "Diff against the starter" table is
the complete list of files that may differ; everything else stays byte-identical and is
refreshed with `pnpm --filter @platform/storefront-brand-a sync` after merging main.

## Owner

window 10 (brands). The starter itself is window 3 — never edit it from here; file a REQUEST.
No Dockerfile in this app: `**/Dockerfile` is window 5's (REQUEST filed for the image).

## Run / test

- `pnpm mock` — Prism Store API on :4010
- `pnpm --filter @platform/storefront-brand-a dev` — brand A on **:3101**
- `build` / `start` (honours `$PORT`, default 3101; `GET /health` → 200) / `typecheck` / `test` / `e2e` / `lighthouse`
- Against the core: `STORE_API_URL=http://localhost:9000` (core runs with
  `CORE_STORE_API_FALLBACK=1` + `CORE_STORE_API_FALLBACK_URL=http://localhost:4010`).
- Root gate before finishing a task: `pnpm lint && pnpm typecheck && pnpm test --filter @platform/storefront-brand-a`.

## Constraints

Everything in the starter's CLAUDE.md applies unchanged (Store API only, no business logic,
hosted payment fields, tenant client for any DB access, no secrets/PII). Brand work happens in
`src/brand/**` and whole route files; `src/lib/**` edits belong in the starter (REQUEST to
window 3) so re-syncs stay clean. Update README.md and CHANGELOG.md with every change.
