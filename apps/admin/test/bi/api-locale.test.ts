// BI Q&A's admin locale (#606, bi-qa-answer@2): `askMetrics` forwards the Accept-Language its route handler passes
// in (the core keeps only a valid first tag, else `en`); with none it sends no header. No `next/headers` here: the
// contract tests call this wrapper outside a request scope (#683's queue run).
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  headers: () => {
    throw new Error('`headers` was called outside a request scope');
  },
}));
const adminCall = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/admin', () => ({ adminCall }));
vi.mock('@/lib/auth/current-session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/env', () => ({ env: {} }));

import { askMetrics } from '@/app/(hq)/bi/_api';

describe('askMetrics forwards the admin locale it is given', () => {
  beforeEach(() => {
    adminCall.mockReset();
    adminCall.mockResolvedValue({ ok: true, status: 200, data: {} });
  });

  it('the Accept-Language goes along as it came', async () => {
    await askMetrics({ question: 'Umsatz?' }, 'de-DE,de;q=0.9,en;q=0.8');
    expect(adminCall).toHaveBeenCalledWith({
      path: '/admin/metrics/ask',
      method: 'POST',
      body: { question: 'Umsatz?' },
      headers: { 'accept-language': 'de-DE,de;q=0.9,en;q=0.8' },
    });
  });

  it.each([[undefined], [null], ['']])(
    'none (%j): no header is sent, and nothing reads the request scope',
    async (acceptLanguage) => {
      await askMetrics({ question: 'bookings?' }, acceptLanguage);
      expect(adminCall.mock.calls[0]![0]).not.toHaveProperty('headers');
    },
  );
});
