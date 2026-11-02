// BI Q&A's admin locale (#606, bi-qa-answer@2): `askMetrics` forwards the browser's Accept-Language to the core,
// which keeps only a valid first tag (else `en`); with no header it sends none.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const incoming = vi.hoisted(() => ({ value: null as string | null }));
vi.mock('next/headers', () => ({
  headers: async () =>
    new Headers(incoming.value === null ? {} : { 'accept-language': incoming.value }),
}));
const adminCall = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/admin', () => ({ adminCall }));
vi.mock('@/lib/auth/current-session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/env', () => ({ env: {} }));

import { askMetrics } from '@/app/(hq)/bi/_api';

describe('askMetrics forwards the admin locale', () => {
  beforeEach(() => {
    adminCall.mockReset();
    adminCall.mockResolvedValue({ ok: true, status: 200, data: {} });
  });

  it('the browser Accept-Language goes along as it came', async () => {
    incoming.value = 'de-DE,de;q=0.9,en;q=0.8';
    await askMetrics({ question: 'Umsatz?' });
    expect(adminCall).toHaveBeenCalledWith({
      path: '/admin/metrics/ask',
      method: 'POST',
      body: { question: 'Umsatz?' },
      headers: { 'accept-language': 'de-DE,de;q=0.9,en;q=0.8' },
    });
  });

  it('no header: none is sent (the core answers in the question language, else en)', async () => {
    incoming.value = null;
    await askMetrics({ question: 'bookings?' });
    expect(adminCall.mock.calls[0]![0]).not.toHaveProperty('headers');
  });
});
