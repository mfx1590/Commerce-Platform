# `src/lib/cms` — the CMS fetch layer

Owner: window 6 (cms). The typed reads the `(content)` routes use, preview mode, and the
revalidate-on-publish webhook. Schemas, datasets and fixtures live in `@platform/cms` (`cms/`),
whose README explains the Studio, tokens and the content model.

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
fallback (task 2.3). The problem is reported with one `console.warn` — once per process for missing
configuration, once per failed request otherwise — carrying the status and Sanity's request id,
never a token or the response body.

## Client

`client.ts` is a plain `fetch` wrapper over Sanity's HTTP query API, no `@sanity/client`, for the
same reasons `src/lib/store-api` is one: a single module knows the URLs and the token, tests inject
`fetchImpl`, and Next's data cache does the caching.

| Perspective   | Host               | Token               | Caching                                       |
| ------------- | ------------------ | ------------------- | --------------------------------------------- |
| **published** | `apicdn.sanity.io` | none                | `next: { tags, revalidate: 300 }`             |
| **preview**   | `api.sanity.io`    | `SANITY_READ_TOKEN` | `cache: 'no-store'` (drafts are never cached) |

GROQ parameters travel as `$name=<json>` query parameters and are never interpolated into the
query. Queries return whole documents; image assets stay references, resolved by the image loader
(task 2.5) without a second round trip.

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
reads **drafts** through the live API; everything else reads published content from the CDN. The
redirect target must be a same-site path (no open redirect). `GET /api/cms/preview/exit` clears it.

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

## Route handlers

`src/app/api/cms/{preview,preview/exit,revalidate}/route.ts` are one-liners over `handlers.ts`,
which exposes pure `Request → Response` functions with the environment, the dataset and
`revalidateTag` injected. They sit outside the `[locale]` tree like `/health` and `/auth/*`: the
webhook URL and the Studio's preview link must not grow a locale prefix.

## Tests

```bash
pnpm --filter @platform/storefront-starter test   # cms-client, cms-reader, cms-preview, cms-revalidate
```
