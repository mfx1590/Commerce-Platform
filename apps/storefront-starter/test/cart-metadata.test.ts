import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * #102 part 2: `cartMetadata()` is on the path that must never cost an order, so it degrades to
 * "no attribution" for *every* way the cookie can fail — not just the one that returns `undefined`.
 */

const cookiesMock = vi.hoisted(() => vi.fn());
vi.mock('next/headers', () => ({ cookies: cookiesMock }));

const { cartMetadata } = await import('@/lib/cart');

function cookieStore(get: () => { value: string } | undefined) {
  return { get };
}

afterEach(() => {
  vi.restoreAllMocks();
  cookiesMock.mockReset();
});

describe('cartMetadata', () => {
  it('returns the attribution when the cookie holds valid JSON', async () => {
    const attribution = {
      first: { landing_path: '/en-GB', at: '2026-09-07T10:00:00.000Z' },
      last: { landing_path: '/en-GB/products', at: '2026-09-14T09:30:00.000Z' },
      captured_at: '2026-09-14T09:30:00.000Z',
    };
    cookiesMock.mockResolvedValue(cookieStore(() => ({ value: JSON.stringify(attribution) })));

    const metadata = await cartMetadata();
    expect(metadata?.attribution.first.landing_path).toBe('/en-GB');
  });

  it('is undefined when there is no cookie at all', async () => {
    cookiesMock.mockResolvedValue(cookieStore(() => undefined));
    await expect(cartMetadata()).resolves.toBeUndefined();
  });

  it('is undefined for a malformed cookie rather than throwing', async () => {
    cookiesMock.mockResolvedValue(cookieStore(() => ({ value: '{"first":' })));
    await expect(cartMetadata()).resolves.toBeUndefined();
  });

  it('survives a cookie store that throws — the read is inside the guard, not before it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    cookiesMock.mockResolvedValue(
      cookieStore(() => {
        throw new Error('cookie store unavailable');
      }),
    );

    // Before #102 this threw out of `getOrCreateCart` and lost the order, not just the attribution.
    await expect(cartMetadata()).resolves.toBeUndefined();
  });

  it('survives `cookies()` itself rejecting', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    cookiesMock.mockRejectedValue(new Error('called outside a request scope'));
    await expect(cartMetadata()).resolves.toBeUndefined();
  });
});
