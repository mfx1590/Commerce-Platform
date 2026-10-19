import { localeConfigFromEnv } from '../src/i18n/locale-config.mjs';

/**
 * The e2e server's warm-up (moved out of `scripts/e2e-server.mjs` so it can be tested, #441 part 4).
 *
 * "Warm" is a page and a static chunk each answering under `quickMs`, `streak` times in a row — the
 * two kinds of request the first tests make, and the two that stalled (#298 review).
 *
 * **The page is the app's own default locale** (`localeConfigFromEnv`, the definition routing uses),
 * never a literal: brand C sells `en-US`, and `/en-GB` there is not a page at all.
 *
 * **A redirect is not warm.** next-intl answers an unknown locale with `307 → /<default>/<path>` and a
 * 12-byte body. The old loop counted the 307 as a page (it is under 400), found no chunk in the body,
 * and spun 120 times before throwing a message about latency for a page that answered in 5 ms. A 3xx
 * now fails at once and names where it points.
 */

export const QUICK_MS = 1_000;
export const WARM_STREAK = 2;
export const WARM_DEADLINE_MS = 120_000;

/**
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export function warmUpPath(env) {
  return `/${localeConfigFromEnv(env).defaultLocale}`;
}

/** Thrown for a configuration problem a retry cannot fix: stop at once. */
class WarmUpRedirect extends Error {}

/**
 * @param {{
 *   appUrl: string,
 *   path: string,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   quickMs?: number,
 *   streak?: number,
 *   deadlineMs?: number,
 *   log?: (line: string) => void,
 * }} options
 * @returns {Promise<void>}
 */
export async function warmUpServer(options) {
  const {
    appUrl,
    path,
    fetchImpl = fetch,
    now = () => globalThis.performance.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    quickMs = QUICK_MS,
    streak: needed = WARM_STREAK,
    deadlineMs = WARM_DEADLINE_MS,
    log = (line) => console.error(line),
  } = options;

  /** One timed GET: `null` when it failed, else milliseconds and the body as text. */
  async function timed(target) {
    const started = now();
    try {
      const response = await fetchImpl(appUrl + target, {
        headers: { 'user-agent': 'e2e-server warm-up' },
        redirect: 'manual',
        signal: globalThis.AbortSignal.timeout(30_000),
      });
      const body = await response.text();
      if (response.status >= 300 && response.status < 400) {
        throw new WarmUpRedirect(
          `[e2e-server] ${target} answered ${response.status} → ${
            response.headers.get('location') ?? '(no location)'
          }: the warm-up page must be a page. Is ${target.slice(1)} one of this app's locales ` +
            '(SUPPORTED_LOCALES / DEFAULT_LOCALE)?',
        );
      }
      if (response.status >= 400) return null;
      return { ms: now() - started, body };
    } catch (error) {
      if (error instanceof WarmUpRedirect) throw error;
      return null;
    }
  }

  const deadline = now() + deadlineMs;
  let streak = 0;
  let attempts = 0;
  let chunkPath = null;

  while (now() < deadline) {
    attempts += 1;
    const page = await timed(path);
    if (page !== null && chunkPath === null) {
      // Any chunk the page itself loads: discovered, not hard-coded, so a renamed hash is fine.
      chunkPath = /"(\/_next\/static\/chunks\/[^"]+\.js)"/.exec(page.body)?.[1] ?? null;
    }
    const chunk = chunkPath === null ? null : await timed(chunkPath);

    const quick = page !== null && chunk !== null && page.ms < quickMs && chunk.ms < quickMs;
    streak = quick ? streak + 1 : 0;
    const report = `page ${page === null ? 'failed' : `${Math.round(page.ms)} ms`}, chunk ${
      chunk === null
        ? page === null
          ? 'not tried'
          : chunkPath === null
            ? 'not found in the page'
            : 'failed'
        : `${Math.round(chunk.ms)} ms`
    }`;
    log(`[e2e-server] warm-up ${attempts}: ${report}${quick ? '' : ' — not yet'}`);
    if (streak >= needed) return;

    await sleep(1_000);
  }
  throw new Error(
    `[e2e-server] the app on ${appUrl} did not answer ${path} and a static chunk under ${quickMs} ms ` +
      `${needed} times in a row within ${deadlineMs / 1000} s`,
  );
}
