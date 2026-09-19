# `src/lib/cms` — the CMS fetch layer and content routes

Owner: window 6 (cms). The typed reads the `(content)` routes use, preview mode, the
revalidate-on-publish webhook, and the components that render CMS documents. Schemas, datasets and
fixtures live in `@platform/cms` (`cms/`), whose README explains the Studio, tokens and the content
model.

## Reads

```tsx
import { getCms } from '@/lib/cms';

const cms = await getCms(); // one per render (React cache): store + preview cookie resolved once
const page = await cms.page(locale, slug); // PageDocument | null
const nav = await cms.navigation(locale); // 'main' by default
```

`getCms()` binds `reader.ts` to Next: the environment (`SANITY_*`), the store from `GET /store`
(`store.code` picks the dataset through `datasetForStore`), and the preview cookie. Everything
else is in `reader.ts` and is tested with fakes.

**Reads never throw.** No `SANITY_PROJECT_ID`, an unresolvable store, a store without a dataset, a
network failure or a 500 from Sanity all yield `null` / `[]`, and the routes render their static
fallback. The problem is reported with one `console.warn` — once per process for missing
configuration, once per failed request otherwise — carrying the status and Sanity's request id,
never a token or the response body.

## Content routes

| Route                      | Document                    | Empty CMS                              |
| -------------------------- | --------------------------- | -------------------------------------- |
| `/[locale]/pages/[slug]`   | `page`                      | 404 (translated)                       |
| `/[locale]/legal/[slug]`   | `legal`                     | 404 (translated)                       |
| `(content)` layout         | `navigation` main, `footer` | the starter's static links + copyright |
| home slots (`HomeContent`) | `page` with slug `home`     | renders nothing                        |

`getContent(locale)` (`content.ts`) returns the reader plus a `ContentContext`: the locale, the
`content` translator and the image source. Pages take the hero as their `<h1>` when there is one
and the title otherwise, so every page has exactly one `<h1>`; block heroes render as `<h2>`.
Metadata comes from the `seo` object with the title as fallback, `noIndex` as a robots directive,
the share image, and canonical / hreflang for every locale (`metadata.ts`).

No `generateStaticParams`: `next build` runs with no CMS reachable (CI), so pages render on demand
and cache at the fetch layer by tag, exactly like the PLP and PDP; a publish drops one page via the
webhook.

## Components (`components/`)

| Component                 | Renders                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `Hero`                    | eyebrow, headline (`h1` or `h2`), subheadline, image, up to two CTAs, three layouts           |
| `Blocks`                  | `richText`, `imageBlock` (figure + caption), `productStory`, `cta`, `hero`; unknown → nothing |
| `PortableText`            | normal / h2 / h3 / blockquote, bullet and numbered lists, strong / em, links, inline images   |
| `ProductStory`            | CMS copy around a live product from `getProduct(handle)`; API failure → copy only             |
| `SanityImage`             | `<img>` with alt, intrinsic size and a CDN URL built from the asset ref (2.5 adds the loader) |
| `CmsHeader` / `CmsFooter` | navigation and footer documents, with the starter's static links / copyright as fallback      |
| `HomeContent`             | hero + blocks of the `home` page; nothing when unpublished                                    |
| `PreviewBanner`           | a `role="status"` strip with an exit link while the preview cookie is valid                   |

**Mount points for window 3 (REQUEST #178):** `CmsHeader` / `CmsFooter` in `src/layouts/defaults.tsx`
so the shop chrome follows the CMS, and `HomeContent` in `src/app/[locale]/(shop)/page.tsx`. A brand
app can use the same components in its own routes.

**Links.** The schema only admits storefront paths (`/…`) and `https://` URLs. Paths render through
next-intl's locale-aware `Link`; external URLs render as `<a rel="noopener noreferrer">`, in a new
tab when the editor asked for it.

## Strings: the `content` namespace

Every string these routes and components render that is not CMS content comes from
`messages/{en-GB,de-DE}.json` in this folder, through next-intl's `createTranslator`
(`content.ts`). A locale without a catalogue falls back to its language, then to English.
`test/cms-i18n.test.ts` keeps the two catalogues in step (same keys, same placeholders, actually
translated) and `test/cms-content.test.ts` scans the routes and components for JSX text and
user-facing attribute literals, the same rule `test/i18n.test.ts` applies to `(shop)` and
`(checkout)`. REQUEST #178 merges the namespace into the app-wide messages as well.

## Client

`client.ts` is a plain `fetch` wrapper over Sanity's HTTP query API, no `@sanity/client`, for the
same reasons `src/lib/store-api` is one: a single module knows the URLs and the token, tests inject
`fetchImpl`, and Next's data cache does the caching.

| Perspective   | Host               | Token               | Caching                                       |
| ------------- | ------------------ | ------------------- | --------------------------------------------- |
| **published** | `apicdn.sanity.io` | none                | `next: { tags, revalidate: 300 }`             |
| **preview**   | `api.sanity.io`    | `SANITY_READ_TOKEN` | `cache: 'no-store'` (drafts are never cached) |

GROQ parameters travel as `$name=<json>` query parameters and are never interpolated into the
query. Queries return whole documents; image assets stay references, resolved from the ref without
a second round trip.

## Cache tags

Every published read carries three tags, coarse to fine, so a publish can drop one document, one
type, or everything:

| Tag                         | Dropped when                  |
| --------------------------- | ----------------------------- |
| `cms`                       | anything is published         |
| `cms:page`                  | any page is published         |
| `cms:page:en-GB:about`      | this page is published        |
| `cms:navigation:en-GB:main` | navigation (key) is published |
| `cms:footer:en-GB:default`  | the footer is published       |

## Preview mode

`GET /api/cms/preview?secret=<SANITY_PREVIEW_SECRET>&redirect=/en-GB/pages/about` sets the
`cms_preview` cookie — httpOnly, SameSite=Lax, Secure in production, two hours — whose value is
`<expiry>.<HMAC-SHA256(secret, "<dataset>|<expiry>")>`. Nothing in it is secret and nothing in it can
be forged without the secret; the read token never leaves the server. A request with a valid cookie
reads **drafts** through the live API and shows the preview banner; everything else reads published
content from the CDN. The redirect target must be a same-site path (no open redirect).
`GET /api/cms/preview/exit` clears it.

Preview needs both `SANITY_PREVIEW_SECRET` and `SANITY_READ_TOKEN`; the route answers 503 without
them and 401 on a wrong secret. In the Studio, configure the preview URL as
`https://<storefront>/api/cms/preview?secret=…&redirect=/<locale>/pages/<slug>`.

## Revalidate on publish

Create a Sanity webhook (sanity.io/manage → API → Webhooks) per dataset:

- URL `https://<storefront>/api/cms/revalidate`, trigger on create, update, delete
- Projection: `{ _id, _type, locale, "slug": slug.current, key }`
- Secret: the value of `SANITY_WEBHOOK_SECRET`

Sanity signs each call as `sanity-webhook-signature: t=<ms>,v1=<base64url HMAC-SHA256(secret, "<t>.<body>")>`;
`revalidate.ts` verifies it in constant time and rejects anything older than five minutes. The
handler then calls `revalidateTag` for the tags above and answers `{ revalidated: [...] }`. An
unknown document type still drops `cms`, so nothing can stay stale. Without a webhook secret the
route answers 503: an unverifiable webhook is refused, never trusted.

## Campaign landings and embeds

`/[locale]/campaign/[slug]` renders a `campaignLanding`: live only between `startsAt` and `endsAt`
(`schedule.ts`, fail-closed on unparseable dates; 404 outside the window), hero as the `<h1>`,
blocks including the **embed**, and `data-campaign-id` on the article for tooling. Campaign
fixtures ship `noIndex`, and the marketing UTM on a shared campaign link is captured by window 3's
middleware exactly as everywhere else (`test/cms-campaign.test.ts` proves the cookie).

`Embed` (`components/embed.tsx`) always renders an `<iframe>` and never a script in the page:

| Source                                                                  | `sandbox`                                                  | Why                                                                                                              |
| ----------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Builder.io / Framer URL (allow-listed https host, re-checked at render) | `allow-scripts allow-same-origin allow-forms allow-popups` | cross-origin frame: "same origin" is the provider's own, needed by their runtimes                                |
| HTML snippet (`srcdoc`)                                                 | `allow-scripts allow-forms allow-popups`                   | a srcdoc frame inherits our origin — with `allow-same-origin` a script could reach the page, so it never gets it |

Both get `referrerpolicy="strict-origin-when-cross-origin"`, `loading="lazy"`, an accessible
`title` from the schema, a clamped height and an empty `allow` list (no camera/mic/payment).

**CSP (for window 3's wave C paste):** the starter sets no `Content-Security-Policy` yet. When it
does (`headers()` in `next.config.mjs`), the embeds need
`frame-src https://builder.io https://cdn.builder.io https://*.builder.io https://*.framer.app https://*.framer.website;`
and `srcdoc` frames are covered by `frame-src` via the page itself. Nothing else changes: no
`script-src` additions, because no third-party script runs outside a frame.

**Every CMS href** (portable text, CTAs, navigation, footer) renders through `SafeLink` over
`safeHref()` (`safe-href.ts`): internal paths → locale-aware Link, `https://` → `<a rel="noopener
noreferrer">`, anything else — a stored `javascript:`, `//host` or `http:` href that predates the
schema rule — degrades to plain text. The schema validates at write time; the renderer still does
not trust the dataset.

## Route handlers

`src/app/api/cms/{preview,preview/exit,revalidate}/route.ts` are one-liners over `handlers.ts`,
which exposes pure `Request → Response` functions with the environment, the dataset and
`revalidateTag` injected. They sit outside the `[locale]` tree like `/health` and `/auth/*`: the
webhook URL and the Studio's preview link must not grow a locale prefix.

## Tests

```bash
pnpm --filter @platform/storefront-starter test   # cms-client, cms-reader, cms-preview, cms-revalidate, cms-content, cms-i18n
```

`test/cms-render.ts` resolves a server-component tree (async components included) into plain data
without a DOM, which is what the rendering assertions — one `<h1>`, no skipped heading levels, alt
text on every image, `aria-label` on the nav, `rel` on external links — run against.
