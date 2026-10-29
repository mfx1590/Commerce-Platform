'use client';

/**
 * The live tiles (#604, D6): today's orders and placed amount per store and currency, from `live_orders` /
 * `live_placed_minor` (the per-minute ingest table, not bookings). Polls its route handler every 15 s while
 * the tab is visible; the token never reaches the browser. A failed poll keeps the last figures and says so, and
 * no event for two minutes marks the tiles stale instead of showing a quiet store as zero sales.
 */
import { useEffect, useState } from 'react';
import { formatMoney } from '@/lib/forms/money';
import { freshness, liveTiles, type MetricResult } from '../_lib/metrics';

export const LIVE_POLL_MS = 15_000;

export function LiveTiles({
  initial,
  endpoint,
  labels,
}: {
  initial: MetricResult;
  /** `/bi/live` or `/<storeId>/bi/live`. */
  endpoint: string;
  /** store id → the code the principal knows it by. */
  labels: Record<string, string>;
}) {
  const [result, setResult] = useState(initial);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const res = await fetch(endpoint, { cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        const next = (await res.json()) as MetricResult;
        if (!stopped) {
          setResult(next);
          setFailed(false);
        }
      } catch {
        if (!stopped) setFailed(true);
      } finally {
        if (!stopped) setNow(new Date());
      }
    };
    const timer = setInterval(poll, LIVE_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [endpoint]);

  const tiles = liveTiles(result);
  const fresh = freshness(result.data_as_of, now);
  return (
    <section aria-label="Live today" className="space-y-2">
      <p className="text-muted text-xs" data-testid="bi-live-freshness">
        Live today (UTC) · {fresh.label}
        {fresh.stale && ' · stale: no recent events'}
        {failed && ' · last refresh failed, showing the previous figures'}
      </p>
      {tiles.length === 0 ? (
        <p className="text-muted text-sm">No orders today yet.</p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {tiles.map((t) => (
            <li
              key={`${t.storeId}:${t.currency}`}
              data-testid="bi-live-tile"
              data-store={t.storeId}
              data-currency={t.currency}
              className={`border-line rounded border px-4 py-3 ${fresh.stale ? 'opacity-60' : ''}`}
            >
              <p className="text-muted font-mono text-xs">
                {labels[t.storeId] ?? t.storeId} · {t.currency}
              </p>
              <p className="mt-1 font-mono text-lg tabular-nums" data-testid="bi-live-orders">
                {t.orders} {t.orders === 1 ? 'order' : 'orders'}
              </p>
              <p className="text-muted font-mono text-xs tabular-nums">
                {formatMoney(t.placed_minor, t.currency)} placed
                {t.aov_minor !== null && ` · AOV ${formatMoney(t.aov_minor, t.currency)}`}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
