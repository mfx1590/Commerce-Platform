import { expect, test } from '@playwright/test';
import { AGAINST_CORE, stamped } from '../api-mode';
import { placeCoreOrder } from '../core-order';
import { BRAND_A, signIn } from '../staff';

/**
 * #604 latency, as the manager restated it on #604: event → ClickHouse `mv_orders_minute` < 10 s p95 (measured), and
 * the live tile ≤ one poll interval after that. A MEASUREMENT, opt-in (`E2E_BI_LATENCY=1`, core mode, the machine):
 * it writes `E2E_BI_LATENCY_ORDERS` (default 20) guest orders on brand-a, one at a time, as the store admin with
 * `/<brand-a>/bi` open and never reloaded.
 *
 * Per order, on this process's clock:
 * - `mv_ms`: from the Store API's `complete` answering to the order's row being visible in `orders_minute_events`
 *   (the MV's target), polled every 100 ms over ClickHouse HTTP as the read-only user. That is the whole pipeline:
 *   the outbox write, the relay's poll (1 s), the bus, the ingest's batch, the insert that fires the MV.
 * - `tile_ms`: from that row being visible to the tile showing the new count (sampled every 250 ms).
 * - `server_ms` (cross-check): `ingested_at − occurred_at` of that row's event, both stamped on this machine.
 * Prints one `[bi latency]` JSON line with every sample and p50/p95, and asserts both targets.
 */
const ORDERS = Number(process.env.E2E_BI_LATENCY_ORDERS ?? 20);
const CORE_URL = process.env.CORE_URL ?? 'http://localhost:9000';
/** The tiles' poll interval (`LIVE_POLL_MS` in _components/live-tiles.tsx, a client module this spec does not load). */
const POLL_MS = 15_000;
/** One fetch round trip plus render, plus the 250 ms sampling of this spec, on top of a poll interval. */
const TILE_SLACK_MS = 1_500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function chRow(
  orderId: string,
): Promise<{ occurred_at: string; ingested_at: string } | undefined> {
  if (!UUID.test(orderId)) throw new Error('not an order id');
  const url = process.env.CLICKHOUSE_URL ?? 'http://127.0.0.1:18123';
  const auth = Buffer.from(
    `${process.env.CLICKHOUSE_READONLY_USER ?? ''}:${process.env.CLICKHOUSE_READONLY_PASSWORD ?? ''}`,
  ).toString('base64');
  const db = process.env.CLICKHOUSE_DATABASE ?? 'analytics';
  // the id is a validated UUID; no customer identifier is involved
  const sql = `SELECT toString(r.occurred_at) AS occurred_at, toString(o.ingested_at) AS ingested_at
    FROM ${db}.orders_minute_events AS o INNER JOIN ${db}.raw_events AS r ON r.event_id = o.event_id
    WHERE o.order_id = toUUID('${orderId}') LIMIT 1 FORMAT JSONEachRow`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Basic ${auth}` },
    body: sql,
  });
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = (await res.text()).trim();
  return text === '' ? undefined : (JSON.parse(text.split('\n')[0]!) as never);
}

/** `toString(DateTime64(3, 'UTC'))` is `2026-10-29 14:00:00.123`: UTC, a space for the T. */
const chTime = (s: string) => Date.parse(`${s.replace(' ', 'T')}Z`);

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};

test('latency: event → mv_orders_minute p95 < 10 s, and the tile ≤ one poll interval after it', async ({
  page,
  request,
}) => {
  test.skip(
    !AGAINST_CORE || process.env.E2E_BI_LATENCY !== '1',
    'a measurement: E2E_API=core and E2E_BI_LATENCY=1 (it writes orders; the machine)',
  );
  test.setTimeout(ORDERS * 60_000 + 120_000);

  await signIn(page, `/${BRAND_A}/bi`);
  await expect(page.getByTestId('bi-live-freshness')).toBeVisible();
  const tile = page.getByTestId('bi-live-tile').and(page.locator('[data-currency="EUR"]'));
  const ordersOf = async () =>
    (await tile.count()) === 0
      ? 0
      : Number(/(\d+)/.exec((await tile.getByTestId('bi-live-orders').textContent()) ?? '')?.[1]);
  let count = await ordersOf();

  const samples: { order: number; mv_ms: number; tile_ms: number; server_ms: number }[] = [];
  for (let i = 0; i < ORDERS; i++) {
    const placed = await placeCoreOrder(request, CORE_URL, stamped(`bi-latency-${i}`));
    const t0 = Date.now();
    let row: Awaited<ReturnType<typeof chRow>>;
    while (!(row = await chRow(placed.id))) {
      if (Date.now() - t0 > 60_000)
        throw new Error(`order ${placed.display_id} not in the MV after 60 s`);
      await page.waitForTimeout(100);
    }
    const tMv = Date.now();
    count += 1;
    while ((await ordersOf()) < count) {
      if (Date.now() - tMv > 60_000)
        throw new Error(`order ${placed.display_id}: no tile after 60 s`);
      await page.waitForTimeout(250);
    }
    const tTile = Date.now();
    samples.push({
      order: placed.display_id,
      mv_ms: tMv - t0,
      tile_ms: tTile - tMv,
      server_ms: chTime(row.ingested_at) - chTime(row.occurred_at),
    });
  }

  const summary = (k: 'mv_ms' | 'tile_ms' | 'server_ms') => ({
    p50: pct(
      samples.map((s) => s[k]),
      50,
    ),
    p95: pct(
      samples.map((s) => s[k]),
      95,
    ),
    max: Math.max(...samples.map((s) => s[k])),
  });
  const result = {
    orders: samples.length,
    event_to_mv: summary('mv_ms'),
    mv_to_tile: summary('tile_ms'),
    server_ingested_minus_occurred: summary('server_ms'),
    poll_ms: POLL_MS,
    samples,
  };
  console.info(`[bi latency] ${JSON.stringify(result)}`);
  await test.info().attach('bi-latency.json', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  });
  expect(result.event_to_mv.p95, 'event → mv_orders_minute p95').toBeLessThan(10_000);
  expect(result.mv_to_tile.max, 'tile after the MV, worst order').toBeLessThanOrEqual(
    POLL_MS + TILE_SLACK_MS,
  );
});
