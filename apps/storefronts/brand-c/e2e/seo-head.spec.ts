import http from 'node:http';
import { expect, test } from '@playwright/test';
// The app's own locales (#441 part 1): a one-locale brand emits one alternate plus x-default.
import { LOCALES } from './support/locale';

/**
 * Where the metadata is in the HTML the server sends (#274).
 *
 * Since Next 15.2 `generateMetadata` is streamed for every user agent that does not match
 * `htmlLimitedBots`: the document's `</head>` closes first and title, description, canonical, the
 * `hreflang` alternates and the og/twitter tags follow somewhere in `<body>`. A browser's DOM still
 * finds them, so every page-level assertion passes — while Google ignores `hreflang` outside
 * `<head>` and Lighthouse's `meta-description` audit fails. `next.config.mjs` therefore makes the
 * metadata blocking for everyone, and this spec is what holds it there.
 *
 * Three things about how it asserts, each learned the hard way:
 *
 * - **Raw bytes, no page.** The question is what a crawler reads off the wire, and a rendered page
 *   would answer a different one. The requests go through `node:http` so that the no-`User-Agent`
 *   case really sends none — Playwright's own client always adds one.
 * - **Byte offsets, never line ranges.** The HTML is a single line; "the lines up to `</head>`" is
 *   the whole document and reports a false pass.
 * - **Twice per route.** Streamed metadata is a race the first request after boot can win, which is
 *   exactly how this hid: one curl, or Lighthouse's first run, says "in head".
 */

const BROWSER_AGENTS = {
  'desktop chrome':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  // What Lighthouse 12 sends under mobile emulation. It carries no `Chrome-Lighthouse` token, so
  // Next's default bot list does not recognise it.
  'lighthouse mobile':
    'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  // Renders JavaScript, so Next's default list leaves it out — and it is the reader `hreflang` is for.
  googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  curl: 'curl/8.9.1',
  'no user-agent header': null,
  // Not the same request as the one above: the header is present and says nothing. Next treats
  // both as "no user agent" and streams, so the middleware has to catch both.
  'empty user-agent header': '',
} as const satisfies Record<string, string | null>;

/** Every one of these must sit before `</head>`; `count` is how many the route must carry. */
const HEAD_TAGS = [
  { name: 'title', needle: '<title', count: 1 },
  { name: 'description', needle: 'name="description"', count: 1 },
  { name: 'canonical', needle: 'rel="canonical"', count: 1 },
  // One per locale plus `x-default`.
  { name: 'hreflang alternate', needle: 'rel="alternate"', count: LOCALES.length + 1 },
  { name: 'open graph', needle: 'property="og:', count: 1 },
  { name: 'twitter card', needle: 'name="twitter:', count: 1 },
] as const;

interface RawResponse {
  status: number;
  /** latin1 on purpose: one character per byte, so a string index *is* a byte offset. */
  html: string;
}

function fetchRaw(url: string, userAgent: string | null): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      url,
      { headers: userAgent === null ? {} : { 'user-agent': userAgent } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            html: Buffer.concat(chunks).toString('latin1'),
          }),
        );
        response.on('error', reject);
      },
    );
    request.on('error', reject);
  });
}

function offsetsOf(html: string, needle: string): number[] {
  const offsets: number[] = [];
  for (let at = html.indexOf(needle); at !== -1; at = html.indexOf(needle, at + 1)) {
    offsets.push(at);
  }
  return offsets;
}

function expectMetadataInHead(html: string, label: string): void {
  const headEnd = html.indexOf('</head>');
  expect(headEnd, `${label}: the document has a </head>`).toBeGreaterThan(-1);

  for (const tag of HEAD_TAGS) {
    const offsets = offsetsOf(html, tag.needle);
    const inHead = offsets.filter((at) => at < headEnd);
    // `<title` can legitimately recur in the body (an SVG's accessible name), so the head count is
    // what is asserted for it; for everything else a single copy in the body is the defect.
    const strays = tag.name === 'title' ? [] : offsets.filter((at) => at > headEnd);

    expect(
      inHead.length,
      `${label}: ${tag.name} — ${inHead.length} before </head> (byte ${headEnd}), ` +
        `found at byte(s) [${offsets.join(', ')}]`,
    ).toBeGreaterThanOrEqual(tag.count);
    expect(strays, `${label}: ${tag.name} emitted after </head> (byte ${headEnd})`).toEqual([]);
  }
}

/**
 * The PDP is whatever the listing links to first: a product handle is data, and a spec that names
 * one stops running the day the backend is not the mock.
 */
async function firstProductPath(baseURL: string, locale: string): Promise<string> {
  const listing = await fetchRaw(`${baseURL}/${locale}/products`, BROWSER_AGENTS['desktop chrome']);
  const match = new RegExp(`href="(/${locale}/products/[^"?#/]+)"`).exec(listing.html);
  expect(match, `the ${locale} listing links to at least one product`).not.toBeNull();
  return match![1]!;
}

type RouteName = 'home' | 'listing' | 'product' | 'content (not found)';

async function pathFor(route: RouteName, baseURL: string, locale: string): Promise<string> {
  switch (route) {
    case 'home':
      return `/${locale}`;
    case 'listing':
      return `/${locale}/products`;
    case 'product':
      return firstProductPath(baseURL, locale);
    // No CMS dataset exists in any test environment, so the content route is exercised on its
    // not-found path — which renders through the same root layout and must be just as readable.
    case 'content (not found)':
      return `/${locale}/pages/seo-head-spec`;
  }
}

const ROUTES: readonly RouteName[] = ['home', 'listing', 'product', 'content (not found)'];

for (const route of ROUTES) {
  for (const locale of LOCALES) {
    for (const [agent, userAgent] of Object.entries(BROWSER_AGENTS)) {
      test(`${route} · ${locale} · ${agent}: metadata is inside <head>, on both requests`, async ({
        baseURL,
      }) => {
        expect(baseURL).toBeDefined();
        const path = await pathFor(route, baseURL!, locale);

        for (const attempt of ['first request', 'repeat request']) {
          const { status, html } = await fetchRaw(`${baseURL}${path}`, userAgent);
          const label = `${path} (${agent}, ${attempt}, status ${status})`;

          // A redirect would mean the offsets below describe some other document.
          expect([200, 404], `${label}: answered directly`).toContain(status);
          expectMetadataInHead(html, label);
        }
      });
    }
  }
}
