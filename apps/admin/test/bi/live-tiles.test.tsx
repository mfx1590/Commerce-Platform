/**
 * The live tiles (#604): render per store × currency (never one sum), poll their route handler every 15 s while the
 * tab is visible, keep the last figures when a poll fails, and say when the data is stale.
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIVE_POLL_MS, LiveTiles } from '@/app/(hq)/bi/_components/live-tiles';
import type { MetricResult } from '@/app/(hq)/bi/_lib/metrics';

const A = '00000000-0000-4000-8000-000000000031';
const NOW = new Date('2026-10-29T10:00:00Z');

const live = (orders: number, asOf: string | null = '2026-10-29T09:59:50Z'): MetricResult => ({
  query: {
    metrics: ['live_orders', 'live_placed_minor'],
    dimensions: ['store'],
    grain: 'total',
    from: '2026-10-29',
    to: '2026-10-30',
    limit: 1000,
  },
  generated_at: '2026-10-29T10:00:00Z',
  data_as_of: asOf,
  truncated: false,
  rows: [
    {
      period: null,
      currency: 'EUR',
      store_id: A,
      product_id: null,
      refund_reason: null,
      provider: null,
      values: { live_orders: orders, live_placed_minor: orders * 2500 },
    },
    {
      period: null,
      currency: 'GBP',
      store_id: A,
      product_id: null,
      refund_reason: null,
      provider: null,
      values: { live_orders: 1, live_placed_minor: 1000 },
    },
  ],
  currency_totals: [],
});

const fetchMock = vi.fn();
beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const tick = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(LIVE_POLL_MS);
  });
};

describe('LiveTiles', () => {
  it('one tile per store × currency, labelled by the store code, AOV from live figures', () => {
    render(<LiveTiles initial={live(2)} endpoint="/bi/live" labels={{ [A]: 'brand-a' }} />);
    const tiles = screen.getAllByTestId('bi-live-tile');
    expect(tiles.map((t) => t.getAttribute('data-currency'))).toEqual(['EUR', 'GBP']);
    expect(tiles[0]!.textContent).toContain('brand-a · EUR');
    expect(tiles[0]!.textContent).toContain('2 orders');
    expect(tiles[0]!.textContent).toContain('€50.00 placed · AOV €25.00');
    expect(screen.getByTestId('bi-live-freshness').textContent).toContain('Updated 10 s ago');
  });

  it('polls its route handler every 15 s and shows the new figures', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(live(3)), { status: 200 }));
    render(<LiveTiles initial={live(2)} endpoint="/brand-a-id/bi/live" labels={{}} />);
    expect(fetchMock).not.toHaveBeenCalled();
    await tick();
    expect(fetchMock).toHaveBeenCalledWith('/brand-a-id/bi/live', { cache: 'no-store' });
    expect(screen.getAllByTestId('bi-live-orders')[0]!.textContent).toBe('3 orders');
  });

  it('a failed poll keeps the last figures and says so', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 503 }));
    render(<LiveTiles initial={live(2)} endpoint="/bi/live" labels={{}} />);
    await tick();
    expect(screen.getAllByTestId('bi-live-orders')[0]!.textContent).toBe('2 orders');
    expect(screen.getByTestId('bi-live-freshness').textContent).toContain('last refresh failed');
  });

  it('no poll while the tab is hidden', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    render(<LiveTiles initial={live(2)} endpoint="/bi/live" labels={{}} />);
    await tick();
    expect(fetchMock).not.toHaveBeenCalled();
    visibility.mockRestore();
  });

  it('no event for over two minutes is stale, and no event at all says so', () => {
    const first = render(
      <LiveTiles initial={live(2, '2026-10-29T09:55:00Z')} endpoint="/bi/live" labels={{}} />,
    );
    expect(screen.getByTestId('bi-live-freshness').textContent).toContain('stale');
    first.unmount();
    render(<LiveTiles initial={{ ...live(0, null), rows: [] }} endpoint="/x" labels={{}} />);
    expect(screen.getByTestId('bi-live-freshness').textContent).toContain('No events yet');
    expect(screen.getByText('No orders today yet.')).toBeTruthy();
  });
});
