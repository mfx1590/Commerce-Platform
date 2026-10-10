import { describe, expect, it } from 'vitest';
import { warmUpServer, warmUpPath } from '../scripts/e2e-warm.mjs';

/**
 * #441 part 4: the e2e server's warm-up. It warms the app's own default locale, and a redirect is
 * NOT warm: brand C answered `/en-GB` with `307 → /en-US/en-GB` (12 bytes, no chunk to find) and the
 * old loop spun 120 times before blaming latency for a page that answered in 5 ms.
 */
interface Answer {
  status: number;
  body?: string;
  location?: string;
}

const PAGE = '<html><script src="/_next/static/chunks/main-abc.js"></script></html>';

function server(
  answers: Record<string, () => { status: number; body?: string; location?: string }>,
) {
  const calls: string[] = [];
  let clock = 0;
  const fetchImpl = (async (url: string) => {
    const path = new URL(url).pathname;
    calls.push(path);
    const answer: Answer = (answers[path] ?? (() => ({ status: 404 })))();
    clock += 10;
    return {
      status: answer.status,
      headers: { get: (name: string) => (name === 'location' ? (answer.location ?? null) : null) },
      text: async () => answer.body ?? '',
    };
  }) as unknown as typeof fetch;
  const options = {
    appUrl: 'http://127.0.0.1:3103',
    path: '/en-US',
    fetchImpl,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    log: () => {},
  };
  return { calls, options };
}

describe('warmUpPath', () => {
  it('is the app’s default locale', () => {
    expect(warmUpPath({})).toBe('/en-GB');
    expect(warmUpPath({ SUPPORTED_LOCALES: 'en-US' })).toBe('/en-US');
    expect(warmUpPath({ SUPPORTED_LOCALES: 'en-GB,de-DE', DEFAULT_LOCALE: 'de-DE' })).toBe(
      '/de-DE',
    );
  });
});

describe('warmUpServer', () => {
  it('is warm when a page and its chunk answer quickly twice in a row', async () => {
    const { calls, options } = server({
      '/en-US': () => ({ status: 200, body: PAGE }),
      '/_next/static/chunks/main-abc.js': () => ({ status: 200, body: 'js' }),
    });
    await expect(warmUpServer(options)).resolves.toBeUndefined();
    expect(calls.filter((path) => path === '/en-US')).toHaveLength(2);
  });

  it('fails at once on a redirect, naming where it points — never "not yet" 120 times', async () => {
    const { calls, options } = server({
      '/en-US': () => ({ status: 307, body: '/en-US/en-GB', location: '/en-US/en-GB' }),
    });
    await expect(warmUpServer({ ...options })).rejects.toThrow(
      /\/en-US answered 307 → \/en-US\/en-GB/,
    );
    expect(calls).toEqual(['/en-US']);
  });

  it('still gives up at the deadline when the server is merely slow', async () => {
    const { options } = server({ '/en-US': () => ({ status: 503 }) });
    await expect(warmUpServer({ ...options, deadlineMs: 5_000 })).rejects.toThrow(/did not answer/);
  });
});
