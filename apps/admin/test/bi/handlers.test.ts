/**
 * The BI route handlers (#604) with the API wrappers mocked: the live poll and the CSV export narrow to the store of
 * the URL (the API decides access), pass the API's errors through with their status, and the CSV is a download
 * that says what it holds.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const api = vi.hoisted(() => ({ queryMetrics: vi.fn(), queryMetricsCsv: vi.fn() }));
vi.mock('@/app/(hq)/bi/_api', () => api);

const { exportFileName, exportResponse, liveResponse } =
  await import('@/app/(hq)/bi/_lib/handlers');
const { GET: storeLive } = await import('@/app/(store)/[storeId]/bi/live/route');
const { GET: storeExport } = await import('@/app/(store)/[storeId]/bi/export/route');

const A = '00000000-0000-4000-8000-000000000031';

beforeEach(() => {
  vi.clearAllMocks();
  api.queryMetrics.mockResolvedValue({ ok: true, status: 200, data: { rows: [] } });
  api.queryMetricsCsv.mockResolvedValue({ ok: true, csv: 'period,store_id\r\n', truncated: false });
});

describe('the live poll', () => {
  it('HQ asks for the live metrics with no store filter', async () => {
    const res = await liveResponse();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const q = api.queryMetrics.mock.calls[0]![0];
    expect(q.metrics).toEqual(['live_orders', 'live_placed_minor']);
    expect(q.filters).toBeUndefined();
  });

  it('the store view narrows to the store of the URL', async () => {
    await storeLive(new Request('http://x/a/bi/live'), { params: Promise.resolve({ storeId: A }) });
    expect(api.queryMetrics.mock.calls[0]![0].filters).toEqual({ store_ids: [A] });
  });

  it('passes the API refusal through with its status (a 403 stays a 403, never empty tiles)', async () => {
    api.queryMetrics.mockResolvedValue({
      ok: false,
      status: 403,
      error: { code: 'forbidden', message: 'no', details: { object: `store:${A}` } },
    });
    const res = await liveResponse(A);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'forbidden' });
  });
});

describe('the CSV export', () => {
  it('is an attachment named after its scope and window, with X-Truncated', async () => {
    api.queryMetricsCsv.mockResolvedValue({ ok: true, csv: 'a\r\n', truncated: true });
    const res = await storeExport(
      new Request('http://x/a/bi/export?from=2026-03-01&to=2026-03-04'),
      {
        params: Promise.resolve({ storeId: A }),
      },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="bi-period-${A}-2026-03-01-to-2026-03-04.csv"`,
    );
    expect(res.headers.get('x-truncated')).toBe('true');
    const q = api.queryMetricsCsv.mock.calls[0]![0];
    expect(q).toMatchObject({ from: '2026-03-01', to: '2026-03-04', filters: { store_ids: [A] } });
  });

  it.each([
    ['money', ['bookings_minor', 'recognised_minor', 'captured_minor']],
    ['products', ['units', 'product_net_minor']],
    ['period', ['bookings_minor', 'refunds_minor', 'refund_rate_bp']],
  ])(
    '?table=%s exports the query that table is drawn from, narrowed the same way',
    async (table, ms) => {
      const res = await storeExport(
        new Request(`http://x/a/bi/export?table=${table}&from=2026-03-01&to=2026-03-04`),
        { params: Promise.resolve({ storeId: A }) },
      );
      expect(res.headers.get('content-disposition')).toContain(`bi-${table}-${A}-`);
      const q = api.queryMetricsCsv.mock.calls[0]![0];
      expect(q.metrics).toEqual(ms);
      expect(q.filters).toEqual({ store_ids: [A] });
    },
  );

  it('an unknown table is a 400 naming the field, and nothing is asked of the API', async () => {
    const res = await exportResponse(new URL('http://x/bi/export?table=__proto__'));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: 'validation_error',
      details: { field: 'table' },
    });
    expect(api.queryMetricsCsv).not.toHaveBeenCalled();
  });

  it('a principal without finance asking for the money views gets the API 403 as it came', async () => {
    api.queryMetricsCsv.mockResolvedValue({
      ok: false,
      status: 403,
      body: '{"code":"forbidden"}',
      contentType: 'application/json',
    });
    const res = await exportResponse(new URL('http://x/bi/export?table=money'));
    expect(res.status).toBe(403);
    expect(res.headers.get('content-disposition')).toBeNull();
  });

  it('an invalid window falls back to the default one, like the page', async () => {
    await exportResponse(new URL('http://x/bi/export?from=nonsense&to=2026-03-04'));
    const q = api.queryMetricsCsv.mock.calls[0]![0];
    expect(q.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(q.filters).toBeUndefined();
  });

  it("an API error is the API's JSON error with its status, not a CSV", async () => {
    api.queryMetricsCsv.mockResolvedValue({
      ok: false,
      status: 503,
      body: '{"code":"unavailable"}',
      contentType: 'application/json',
    });
    const res = await exportResponse(new URL('http://x/bi/export'));
    expect(res.status).toBe(503);
    expect(res.headers.get('content-disposition')).toBeNull();
    expect(await res.text()).toBe('{"code":"unavailable"}');
  });

  it('the file name never carries anything but [a-z0-9-] from the scope', () => {
    expect(exportFileName('money', '../"evil"\r\n', '2026-03-01', '2026-03-04')).toBe(
      'bi-money-evil-2026-03-01-to-2026-03-04.csv',
    );
  });
});
