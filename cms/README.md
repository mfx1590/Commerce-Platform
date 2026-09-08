# @platform/cms

The headless CMS for the brand storefronts: a [Sanity](https://www.sanity.io) project with **one
dataset per brand**, the shared content schemas, typed documents for the storefront's fetch layer,
fixtures, a validator and a seed script. Owner: window 6 (cms). `cms/<brand>/` content folders
belong to window 10 (brands). See [CLAUDE.md](./CLAUDE.md) for commands and constraints.

Contract with the core: the dataset name **is** `store.code` and is what the core stores as
`store.content_space_id` (docs/domain.md, decision 8). A storefront resolves its dataset from the
store it serves; it never chooses one by hand.

| Store code (`packages/db` seed) | Dataset   | Locales          |
| ------------------------------- | --------- | ---------------- |
| `brand-a`                       | `brand-a` | `en-GB`, `de-DE` |
| `brand-b`                       | `brand-b` | `en-GB`          |
| `brand-c`                       | `brand-c` | `en-US`          |

`src/datasets.ts` is the code form of this table; `test/datasets.test.ts` fails if it drifts from
the seed.

## Environments and tokens

One Sanity **project** holds every brand; environments are datasets, and brands are datasets, so
the names combine: `brand-a` is production content for Brand A. Add `brand-a-staging` on the day
a staging storefront exists — the storefront only needs `content_space_id` to point at it.

Everything secret comes from the repo-root `.env` (created from `.env.example` by `pnpm dev`) and
nothing else. No token is ever committed, logged, or placed in code; see ADR 0006.

| Variable                | Used by                           | Where to get it                                                         |
| ----------------------- | --------------------------------- | ----------------------------------------------------------------------- |
| `SANITY_PROJECT_ID`     | Studio, seed, storefront          | sanity.io/manage → the project → Project ID                             |
| `SANITY_API_VERSION`    | everything (default `2025-02-19`) | pinned in `src/datasets.ts`; the `.env` value overrides                 |
| `SANITY_READ_TOKEN`     | storefront (task 2.2)             | API → Tokens → **Viewer**; only needed to read drafts in preview mode   |
| `SANITY_WRITE_TOKEN`    | `pnpm seed`                       | API → Tokens → **Editor**. Local only; CI never seeds                   |
| `SANITY_PREVIEW_SECRET` | storefront (task 2.2)             | any long random string; signs the preview cookie                        |
| `SANITY_WEBHOOK_SECRET` | storefront (task 2.2)             | the secret you type into the Sanity webhook that revalidates on publish |

Datasets are **private**. Published content reaches the storefront through its server-side fetch
layer, never from the browser, so no CORS origin and no public dataset is needed.

## Run it

```bash
pnpm --filter @platform/cms studio        # Sanity Studio on http://localhost:3333
```

The Studio shows one workspace per brand (`/brand-a`, `/brand-b`, `/brand-c`). It needs
`SANITY_PROJECT_ID` in `.env` and nothing else: editors sign in through sanity.io. `scripts/studio.mjs`
loads the root `.env` and exports the id as `SANITY_STUDIO_PROJECT_ID`, the only prefix Sanity's
CLI passes to the config.

First time on a new project: create it at sanity.io/manage, create the three datasets (private),
invite the marketers as **Editors**, then seed the fixtures:

```bash
pnpm --filter @platform/cms seed -- --dataset brand-a     # or brand-b, brand-c, all
```

The seed uploads a 1×1 placeholder image, rewrites every fixture image to it, and
`createOrReplace`s one document per type with deterministic ids (`page.en-GB.about`), so it can be
re-run at will. Without `SANITY_PROJECT_ID` and `SANITY_WRITE_TOKEN` it writes nothing and prints
these manual steps instead:

1. In sanity.io/manage create (or open) the project and add a dataset named after the store code,
   private.
2. Add a token with Editor rights under API → Tokens; put it in `.env` as `SANITY_WRITE_TOKEN` and
   the project id as `SANITY_PROJECT_ID`. Never commit `.env`.
3. Re-run the seed — or, without a token, open the Studio workspace for that dataset and create one
   document per type following `src/fixtures/index.ts` (upload any image where the fixture has a
   placeholder; alt text is required).

## Test

```bash
pnpm --filter @platform/cms typecheck     # src + tests, then the Studio config
pnpm --filter @platform/cms test          # Vitest, incl. compiling the registry with Sanity's own compiler
```

`typecheck` runs two projects. `tsconfig.json` covers `src/**`, which must build without the
Studio package because `apps/storefront-starter/src/lib/cms` (task 2.2) imports the built `dist/`
and neither the storefront nor CI wants the whole Studio for that. `tsconfig.studio.json` adds
`sanity.config.ts` and the tests. `sanity` is therefore a devDependency, used by the Studio alone.

## Content model

Objects (the pieces a marketer composes with) and documents (what has a URL or a slot):

| Type              | Kind     | Fields (required in bold)                                                                                   |
| ----------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `imageWithAlt`    | image    | **alt** (≤160). Every image in the schema is this type; a bare `image` is not allowed.                      |
| `link`            | object   | **label**, **href** (storefront path `/…` or `https://…`), openInNewTab                                     |
| `cta`             | object   | **label**, **href**, **variant** `primary` / `secondary`                                                    |
| `seo`             | object   | metaTitle (≤70), metaDescription (≤160), ogImage, noIndex                                                   |
| `hero`            | block    | eyebrow, **headline** (≤90), subheadline, image, ctas (≤2), layout                                          |
| `richText`        | block    | **content**: portable text (normal, h2, h3, quote, bullets, numbers, bold, italic, links) and images        |
| `imageBlock`      | block    | **image**, caption, width `content` / `wide`                                                                |
| `productStory`    | block    | **productHandle** (kebab-case, e.g. `alpine-backpack`), **headline**, body, image, cta                      |
| `navItem`         | object   | **label**, **href**, children (≤12 links)                                                                   |
| `footerColumn`    | object   | **heading**, **links** (1–10)                                                                               |
| `page`            | document | **title**, **slug**, **locale**, hero, blocks, seo                                                          |
| `campaignLanding` | document | **title**, **slug**, **locale**, campaignId, **hero**, blocks, startsAt, endsAt (after startsAt), seo       |
| `navigation`      | document | **key** `main` / `utility`, **locale**, **items** (1–8 navItems)                                            |
| `footer`          | document | **locale**, columns (≤4), legalLinks (≤6), socialLinks (≤6), copyright                                      |
| `legal`           | document | **title**, **slug**, **locale**, **kind** terms/privacy/imprint/cookies/returns, **body**, **lastReviewed** |

Blocks available inside `page.blocks` and `campaignLanding.blocks`: hero, richText, imageBlock,
productStory, cta.

**What is deliberately not in the CMS.** Prices, stock, variants and the buy button: a
`productStory` names a product by its handle and the storefront loads the product live from the
Store API (ADR 0004). Links are storefront paths or `https://` URLs only — `javascript:` and
`mailto:` are rejected at the schema.

`campaignLanding.campaignId` is the id of a marketing campaign (Admin → Marketing → Campaigns,
window 17): it lets reporting join a landing page to its campaign. It is plain text in Phase 2; the
storefront passes it through untouched.

## One document per locale

A document belongs to exactly one language: `locale` is a required BCP-47 field (`en-GB`,
`de-DE`, `en-US`) and the `(type, locale, slug)` triple is unique — the Studio queries the dataset
before it lets a second document claim the same address (`uniqueLocaleSlug`).

Why not field-level translation? The storefront routes every page under `/[locale]/…` with
next-intl and renders one language per request. A document per locale maps 1:1 onto that URL, a
GROQ query filters on `locale == $locale` and returns exactly the rendered document, editors see
one page in one language, and a missing translation is a missing document rather than a
half-translated page. It also matches how the store itself works: `store_locale` is a row per
locale, not a column per language.

### Adding a locale (window 10, #141)

Brand content for `de-DE` is a copy of the `en-GB` documents with the locale changed:

1. Make sure the store sells in the locale (`store_locale`, and `SUPPORTED_LOCALES` on the
   storefront) — the storefront 404s a locale the store does not offer.
2. For each `en-GB` document, create the `de-DE` twin: same `slug` (so `/de-DE/pages/about` is
   `/en-GB/pages/about` translated), `locale: 'de-DE'`, translated copy and alt text. In code this
   is the fixture with `locale` and the id changed — `documentId('page', 'de-DE', 'about')` —
   which `pnpm seed` will push; in the Studio it is "Duplicate", then edit the Language field.
3. `navigation` and `footer` need a twin per locale too (`key`/`locale` pairs); the storefront
   falls back to its static chrome when one is missing (task 2.3).
4. Legal pages usually differ per market, not just per language: `legal.kind` stays the same,
   the body is the market's text.

## How a marketer builds a landing page

Task 2.4 (#122) delivers the route and the embed block; the authoring side is already in place:

1. Open the Studio, pick the brand workspace, **Campaign landing page → New**.
2. Title, slug (`spring-sale` becomes `/campaign/spring-sale`), language. Paste the campaign id
   from Admin → Marketing so reporting can attribute the page.
3. Fill the hero (headline, image with alt text, up to two buttons). Add blocks: text, image,
   product story (type the product handle from the shop URL), call to action.
4. SEO tab: meta title and description; tick "Hide from search engines" for paid-only pages.
5. Set "Starts at" / "Ends at" to publish on a schedule. **Publish.** The storefront revalidates
   the page within seconds (task 2.2 webhook); no developer is involved.

## Validation without a Studio

Sanity enforces validation only in the Studio. `validateDocument(doc, schemaTypes)` runs the same
`validation` callbacks in Node: the callbacks receive a `RecordingRule` (immutable, like Sanity's)
and the recorded chain is evaluated while walking fields, named object types and arrays. It covers
what our schemas use — `required`, `min`, `max`, `regex`, `uri`, `unique`, `custom` (async, with
`context.getClient` when you pass one) — and ignores warnings. The tests, the seed and later the
fetch layer's tests rely on it; the Studio stays the authority on anything beyond that subset.

## For the fetch layer (task 2.2)

`@platform/cms` exports the typed documents (`PageDocument`, `CampaignLandingDocument`,
`NavigationDocument`, `FooterDocument`, `LegalDocument`, the block union `PageBlock`),
`DOCUMENT_TYPES`, `documentId`, `datasetForStore(store.code)`, `SANITY_API_VERSION`, the fixtures
and `validateDocument`. Build the package first (`turbo` does, via `dependsOn: ^build`).
