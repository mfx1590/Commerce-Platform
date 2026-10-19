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

### Listing what is routed: `routedDocuments(locale)` (for the sitemap)

```ts
import { campaignIsLive, cmsConfigFromEnv, createReader, type RoutedDocument } from '@/lib/cms';

const reader = createReader({ config: cmsConfigFromEnv(), storeCode }); // not getCms(): no cookie
const documents: RoutedDocument[] = await reader.routedDocuments(locale);
const listed = documents.filter((d) => d.type !== 'campaignLanding' || campaignIsLive(d));
```

Every published `page`, `legal` and `campaignLanding` of the locale as `{ type, slug }`, campaign
landings with their `startsAt` / `endsAt` when set (a missing side is absent, never `null`).

- **Filtered in the query** (`queries.ts`): no document without a slug, and not the `page` with
  slug `home` (`HOME_SLUG`) — it is mounted on `/`, so `/pages/home` would be a duplicate.
- **`seo.noIndex: true` is left out by the reader, not by the query.** The query returns the flag
  (`coalesce(seo.noIndex, false)` — most documents have no `seo` object at all, and they are
  listed); the reader first keeps the newest row per `(type, slug)`, the document the by-slug read
  renders, and then applies that document's flag. Filtering in the query would let an older
  indexable twin be listed in place of a newer noIndex document. Two documents on one
  `(type, locale, slug)` should not exist — the Studio refuses them — but if they do, the list
  describes the one that renders: its `noIndex`, its schedule. The flag is never returned.
- **The schedule is returned, not applied.** The list is cached (tags + `CMS_REVALIDATE_SECONDS`),
  so "live now" is the caller's question at request time — `campaignIsLive` — otherwise an ended
  campaign would stay listed until the next revalidation.
- **Build the reader yourself**, as above. `createReader` and `campaignIsLive` load nothing from
  `next/headers` (a test walks the import graph), so a cached sitemap neither turns dynamic nor
  lists a draft. `getCms()` reads the preview cookie; do not use it for this.
- `[]` when there is nothing, when the CMS is unconfigured or the store unknown, and when the read
  fails (one warning, like every other read).

### Hero video: `hero.video` (#330, the CMS half)

```ts
import type { Hero, HeroVideo } from '@platform/cms';
import { heroVideo } from '@/lib/cms';

// HeroVideo = { _type: 'heroVideo'; cloudinaryUrl: string }   // …/video/upload/…
const page = await cms.page(locale, slug); // PageDocument | null
const loop: HeroVideo | null = page?.hero ? heroVideo(page.hero) : null;
```

A hero (`page.hero`, `campaignLanding.hero`, and `hero` blocks inside `blocks`) may carry an
optional `video`. The reader applies one policy before handing the document out, in
`hero-video.ts` (`normalizeHeroVideo`, no `next/*`): **`hero.video` is present only when
`hero.image` is present and `video.cloudinaryUrl` matches `CLOUDINARY_VIDEO_URL_PATTERN`**
(`https://res.cloudinary.com/<cloud>/video/upload/…`). A stored hero that breaks either rule — the
schema refuses both, but the renderer does not trust the dataset — comes through with the video
removed and the image alone. `heroVideo(hero)` is the same check as a function, for a hero obtained
some other way. Content without the field is unchanged: no `video` key appears.

What the renderer (window 3, later) owes the field, per #330 and brand A's DESIGN.md §7: under
`prefers-reduced-motion: reduce` the poster image renders alone and the video is **never
requested**; otherwise `<video muted playsinline loop autoplay preload="none" poster=…>` with
`aria-hidden="true"`, started after the poster has loaded so the poster stays the LCP element, a
visible pause/play control (WCAG 2.2.2: the loops run 8 s), and the URL through the shared
Cloudinary loader with a capped width. Rendered by `HeroMedia` (`src/components/hero-media.tsx`,
window 3, #330), which wraps the hero's image.

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

| Component                 | Renders                                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `Hero`                    | eyebrow, headline (`h1` or `h2`), subheadline, image (+ optional video loop via `HeroMedia`), up to two CTAs, three layouts |
| `Blocks`                  | `richText`, `imageBlock` (figure + caption), `productStory`, `cta`, `hero`; unknown → nothing                               |
| `PortableText`            | normal / h2 / h3 / blockquote, bullet and numbered lists, strong / em, links, inline images                                 |
| `ProductStory`            | CMS copy around a live product from `getProduct(handle)`; API failure → copy only                                           |
| `SanityImage`             | responsive `<img>` from either source: Cloudinary via the shared @platform/ui loader, or the Sanity asset ref               |
| `CmsHeader` / `CmsFooter` | navigation and footer documents, with the starter's static links / copyright as fallback                                    |
| `HomeContent`             | hero + blocks of the `home` page; nothing when unpublished                                                                  |
| `PreviewBanner`           | a `role="status"` strip with an exit link while the preview cookie is valid                                                 |

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

## Images (task 2.5)

`SanityImage` renders every CMS image from one of two sources. A `cloudinaryUrl` on the image wins:
the `src` and a `srcset` over the width steps (384–1600) are built with `cloudinaryImageLoader`
from `@platform/ui` — window 9's shared loader; this module never hand-rolls a transformation URL.
An https URL the loader does not recognise falls back to the source URL unchanged; a non-https
stored value renders nothing (the renderer does not trust the dataset, same rule as `safeHref`).
Without a `cloudinaryUrl` the Sanity asset ref provides the URL, intrinsic size and a CDN `w=`
srcset. Alt text is schema-required for both, and `test/cms-image.test.ts` asserts the schema's
`CLOUDINARY_URL_PATTERN` and the loader's `isCloudinaryUrl` agree.

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

`routedDocuments` is a list across three types, so it carries `cms`, `cms:page`, `cms:legal` and
`cms:campaignLanding`: publishing any page, legal document or campaign landing drops it.

## Preview mode

`GET /api/cms/preview?secret=<SANITY_PREVIEW_SECRET>&redirect=/en-GB/pages/about` sets the
`cms_preview` cookie — httpOnly, SameSite=Lax, Secure in production, two hours — whose value is
`<expiry>.<HMAC-SHA256(secret, "<dataset>|<expiry>")>`. Nothing in it is secret and nothing in it can
be forged without the secret; the read token never leaves the server. A request with a valid cookie
reads **drafts** through the live API and shows the preview banner; everything else reads published
content from the CDN. The redirect target must satisfy the shared `isSafeInternalPath`
(`src/lib/safe-path.ts`, #273/#277 — control characters a URL parser would strip are rejected, not
just `//` and backslashes), and the handler additionally asserts the resolved origin before
redirecting. `GET /api/cms/preview/exit` clears the cookie; it is **deliberately unauthenticated**:
exit only de-escalates, and requiring the secret would put it in the banner link on every previewed
page (rationale in `handlers.ts`).

**Both redirects land on this site as configured, never on the request's origin (#319).** In a
route handler behind the ingress the request's own URL is the pod's address — `localhost:3100`
whatever `Host` or `X-Forwarded-Host` says — so entering and leaving preview used to send the editor
to localhost on every deployment. The destination is now `urlOnThisSite(path, '/')`
(`src/lib/site-origin.ts`, #298): `SITE_URL` read at request time, the same two safe-path layers
applied to the path. It is never taken from `Host` / `X-Forwarded-Host` (attacker-supplied text —
that would turn a broken redirect into an open one). A production server without `SITE_URL`
**fails closed**: the handler throws `SiteUrlError` (a 500), sets no cookie and redirects nowhere;
under `next dev` and in tests the default `http://localhost:3100` still applies.
`test/cms-preview-origin.test.ts` calls each handler as the server sees it behind the ingress — pod
origin, hostile forwarded host, public origin — and asserts the full `Location`.

Preview needs both `SANITY_PREVIEW_SECRET` and `SANITY_READ_TOKEN`; the route answers 503 without
them and 401 on a wrong secret. A production deployment also needs `SITE_URL`, like the rest of the
storefront. In the Studio, configure the preview URL as
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

`test/cms-routed-documents.test.ts` does not can the answer: its fake Sanity evaluates the reader's
real GROQ against a small dataset with `groq-js`, so each filter is tested where it lives. The
storefront has no dependency on `groq-js`; the test reaches the copy the Studio ships
(`@platform/cms` → `sanity` → `groq-js`) and fails, rather than skips, if it cannot.
