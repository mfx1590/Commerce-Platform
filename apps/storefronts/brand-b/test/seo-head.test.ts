import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config.mjs';

/**
 * #274. Next streams `generateMetadata` into `<body>` for every user agent that does not match
 * `htmlLimitedBots`, and its default list leaves out ordinary browsers, Lighthouse and Googlebot.
 * The rendered position is asserted against a real server in `e2e/seo-head.spec.ts`; this is the
 * cheap half — a config edit that narrows the pattern fails here, in the unit run, rather than
 * only where Playwright runs.
 */

/** Next serialises the pattern to its source and rebuilds it case-insensitively; so does this. */
function blocksMetadataFor(userAgent: string): boolean {
  const pattern = (nextConfig as { htmlLimitedBots?: RegExp }).htmlLimitedBots;
  if (!(pattern instanceof RegExp)) return false;
  return new RegExp(pattern.source, 'i').test(userAgent);
}

describe('next.config htmlLimitedBots', () => {
  it.each([
    [
      'desktop Chrome',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    ],
    [
      'Lighthouse mobile emulation',
      'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
    ],
    ['Googlebot', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'],
    ['Bingbot', 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)'],
    ['curl', 'curl/8.9.1'],
    ['an agent nobody has heard of', 'x'],
  ])('holds the metadata in <head> for %s', (_name, userAgent) => {
    expect(blocksMetadataFor(userAgent)).toBe(true);
  });
});
