/**
 * Warm the URLs a measurement is about to take, before it takes them (#390).
 *
 * `next start` answering `/health` does not mean the measured routes have ever been rendered: their
 * first request pays for loading the route's modules and filling the data cache. Lighthouse's run 1
 * paid that every time (a PLP's TBT 1125 ms against ~75 ms on runs 2 and 3, and a much lower CPU
 * benchmark on the same run), which widened the spread every assertion is computed over.
 *
 * "Warm" is the rule `scripts/e2e-server.mjs` already uses: the URL answers under `quickMs`,
 * `streak` times in a row. Each URL is warmed on its own, so one slow route cannot hide behind a
 * fast one.
 */

export const QUICK_MS = 1_000;
export const WARM_STREAK = 2;
export const WARM_DEADLINE_MS = 120_000;

/**
 * @param {readonly string[]} urls
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   quickMs?: number,
 *   streak?: number,
 *   deadlineMs?: number,
 *   log?: (line: string) => void,
 * }} [options]
 * @returns {Promise<{ url: string, warm: boolean, attempts: number, lastMs: number | null }[]>}
 */
export async function warmUrls(urls, options = {}) {
  const {
    fetchImpl = fetch,
    now = () => globalThis.performance.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    quickMs = QUICK_MS,
    streak: needed = WARM_STREAK,
    deadlineMs = WARM_DEADLINE_MS,
    log = (line) => console.log(line),
  } = options;

  const results = [];
  for (const url of urls) {
    const deadline = now() + deadlineMs;
    let streak = 0;
    let attempts = 0;
    let lastMs = null;
    let warm = false;

    while (now() < deadline) {
      attempts += 1;
      const started = now();
      let ok = false;
      try {
        const response = await fetchImpl(url, {
          // A browser's user agent, so the request takes the same rendering path Lighthouse's will.
          headers: { 'user-agent': 'Mozilla/5.0 (perf warm-up)' },
          signal: globalThis.AbortSignal.timeout(30_000),
        });
        await response.text();
        ok = response.status < 400;
      } catch {
        ok = false;
      }
      lastMs = now() - started;
      const quick = ok && lastMs < quickMs;
      streak = quick ? streak + 1 : 0;
      log(
        `perf: warm-up ${url} #${attempts}: ${ok ? `${Math.round(lastMs)} ms` : 'failed'}${
          quick ? '' : ' — not yet'
        }`,
      );
      if (streak >= needed) {
        warm = true;
        break;
      }
      await sleep(250);
    }
    results.push({ url, warm, attempts, lastMs });
  }
  return results;
}
