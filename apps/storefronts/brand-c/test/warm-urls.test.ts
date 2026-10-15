import { describe, expect, it } from 'vitest';
import { warmUrls } from '../scripts/warm-urls.mjs';

/**
 * #390: the perf gate warms each measured URL before Lighthouse — answering under a second twice in
 * a row, the rule `e2e-server.mjs` uses — so run 1 no longer pays the routes' first render.
 */

/** A fake clock and server: each request to a URL takes the next duration from its script. */
function harness(script: Record<string, (number | 'fail')[]>) {
  let clock = 0;
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    const next = script[url]!.shift() ?? 50;
    if (next === 'fail') throw new Error('connection refused');
    clock += next;
    return { status: 200, text: async () => '' };
  }) as unknown as typeof fetch;
  return {
    calls,
    options: {
      fetchImpl,
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
      log: () => {},
    },
  };
}

describe('warmUrls', () => {
  it('requests each URL until it answers quickly twice in a row', async () => {
    const { calls, options } = harness({ '/plp': [4000, 1500, 300, 200], '/pdp': [100, 90] });
    const results = await warmUrls(['/plp', '/pdp'], options);

    expect(results.map((r) => [r.url, r.warm, r.attempts])).toEqual([
      ['/plp', true, 4],
      ['/pdp', true, 2],
    ]);
    expect(calls).toEqual(['/plp', '/plp', '/plp', '/plp', '/pdp', '/pdp']);
  });

  it('a slow answer or a failure resets the streak', async () => {
    const { options } = harness({ '/plp': [100, 2000, 100, 'fail', 100, 100] });
    const [result] = await warmUrls(['/plp'], options);
    expect(result).toMatchObject({ warm: true, attempts: 6 });
  });

  it('gives up at the deadline and says the URL is not warm', async () => {
    const { options } = harness({ '/plp': Array(100).fill(5000) });
    const [result] = await warmUrls(['/plp'], { ...options, deadlineMs: 20_000 });
    expect(result!.warm).toBe(false);
    expect(result!.attempts).toBeLessThan(10);
  });
});
