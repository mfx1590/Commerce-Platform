# @platform/cms

## Purpose

Sanity workspace for the brand storefronts: one dataset per brand (= `store.code` =
`store.content_space_id`), the shared schemas, typed documents for the storefront's fetch layer,
fixtures, a validator and a seed script. The Studio lives here too (`sanity.config.ts`).

## Owner

window 6 (cms). `cms/<brand>/` content folders are window 10 (brands).

## Run / test

- `pnpm --filter @platform/cms typecheck` — schemas + tests, then the Studio config
- `pnpm --filter @platform/cms test` — Vitest (tests live in test/)
- `pnpm --filter @platform/cms build` — `dist/` consumed by `apps/storefront-starter/src/lib/cms`
- `pnpm --filter @platform/cms studio` — Sanity Studio on :3333 (needs `SANITY_PROJECT_ID` in `.env`)
- `pnpm --filter @platform/cms seed -- --dataset brand-a` — pushes the fixtures (needs `SANITY_WRITE_TOKEN`)
- Root: `pnpm lint && pnpm typecheck && pnpm test --filter @platform/cms` before finishing a task.

## Layout

- `src/schema/define.ts` — structural mirror of Sanity's definition types (no `sanity` import).
- `src/schema/objects.ts`, `src/schema/documents.ts`, `src/schema/index.ts` — the schema registry.
- `src/types.ts` — TS document types the fetch layer consumes; `src/datasets.ts` — brand → dataset.
- `src/validate.ts` — runs the schemas' own rules against a document (tests, seed, fetch layer).
- `src/fixtures/` — one document per type; `src/seed.ts` — pure mutation builder for `scripts/seed.mjs`.
- `sanity.config.ts` — the Studio, one workspace per dataset; typechecked by `tsconfig.studio.json`.

## Constraints

- No secrets in code: tokens and the project id come from the root `.env` (`SANITY_*`).
- `sanity` is a devDependency for the Studio only; `src/**` must not import it.
- Datasets mirror `packages/db` seed store codes; a test enforces it.
- Update README.md and CHANGELOG.md with every change.
