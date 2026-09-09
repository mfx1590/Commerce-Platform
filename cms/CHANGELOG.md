# Changelog — @platform/cms

## 0.2.0 — 2026-09-08

Task [cms] 2.3 (issue #121): the two "later" nits from the PR #163 review.

- `navigation` and `footer` now enforce what the README promised: `uniqueLocaleKey` on
  `navigation.key` (one `main` and one `utility` menu per locale) and `uniqueLocale` on
  `footer.locale` (one footer per locale), Studio-side queries like `uniqueLocaleSlug`.
- `href` fields (links, CTAs, navigation items, portable-text links) accept a storefront path with
  exactly one leading slash or an `https://` URL — `HREF_PATTERN`. `//host` and `http://` used to
  slip through `uri({ allowRelative: true })`; they no longer do. Tests in `test/links.test.ts`.

## 0.1.1 — 2026-09-08

Folded review nits from PR #163, shipped with task [cms] 2.2 (issue #120).

- `test/sanity-compile.test.ts` asserts that Sanity exposes its validation report before reading
  it, and proves the check is not vacuous with a deliberately broken schema (36 tests now).
- CHANGELOG 0.1.0 said 32 tests; it was 35.
- The storefront fetch layer (`apps/storefront-starter/src/lib/cms`, task 2.2) consumes this
  package: typed documents, `datasetForStore`, `SANITY_API_VERSION`, fixtures in its tests.

## 0.1.0 — 2026-09-08

Task [cms] 2.1 (issue #119), contracts `contracts-v0.3`. Root config for the package landed
separately as REQUEST #158 (main 94f1de3).

- New workspace package `@platform/cms`: the Sanity Studio (`sanity.config.ts`, one workspace per
  brand dataset), the schema registry, typed documents for the storefront's fetch layer, fixtures,
  a validator and a seed script.
- Datasets `brand-a`, `brand-b`, `brand-c` = `store.code` = `store.content_space_id`
  (`src/datasets.ts`); a test reads `packages/db`'s seed and fails if the codes or locales drift.
- Schemas: objects `imageWithAlt` (alt text required), `link`, `cta`, `seo`, `hero`, `richText`,
  `imageBlock`, `productStory` (kebab-case product handle, never a price), `navItem`,
  `footerColumn`; documents `page`, `campaignLanding` (`campaignId` for window 17, `startsAt` /
  `endsAt`), `navigation`, `footer`, `legal`. Every document carries a BCP-47 `locale` and the
  `(locale, slug)` pair is unique (Studio-side query in `uniqueLocaleSlug`).
- `src/schema/define.ts`: a structural mirror of Sanity's definition types so `src/**` builds
  without the Studio package; `sanity` is a devDependency for `sanity.config.ts` only, checked by
  `tsconfig.studio.json`.
- `validateDocument`: runs the schemas' own `validation` callbacks (required, min/max, regex, uri,
  unique, custom) against a document without a Studio. 35 tests: registry integrity, alt text,
  handle format, link schemes, bounds, locale format, campaign dates, uniqueness, fixtures, seed
  helpers, datasets.
- `pnpm --filter @platform/cms seed -- --dataset <brand|all>`: uploads a placeholder image and
  `createOrReplace`s the fixtures through Sanity's HTTP API with credentials from `.env` only;
  without them it prints the manual steps and writes nothing.
