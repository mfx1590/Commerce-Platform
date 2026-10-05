import { CONTRACTS_VERSION } from '@platform/contracts';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiModeNotice } from '@/components/shell/api-mode-banner';
import { ApiStatePanel, RequestErrorPanel } from '@/components/states/state-panel';
import type { AdminError, ApiResult } from '@/lib/api/admin-client';
import {
  apiMode,
  probeApiMode,
  resetApiModeCache,
  versionVerdict,
  type ApiModeInfo,
} from '@/lib/api/api-mode';
import { isCollectionRead, reclassifyUnmounted, routeLabel } from '@/lib/api/not-implemented';

vi.mock('server-only', () => ({}));

const CORE = 'http://core.test:9000';
const STORE = '00000000-0000-4000-8000-000000000031';

const answer = (status: number, headers: Record<string, string> = {}) =>
  vi.fn(async () => new Response(status === 200 ? 'OK' : 'nope', { status, headers }));

afterEach(() => {
  resetApiModeCache();
  vi.unstubAllGlobals();
});

describe('probeApiMode: /health tells the core from Prism', () => {
  it('core with a version header', async () => {
    const fetchImpl = answer(200, { 'X-Contracts-Version': '0.4.6' });
    expect(await probeApiMode(CORE, fetchImpl)).toEqual({
      mode: 'core',
      contractsVersion: '0.4.6',
    });
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toBe(`${CORE}/health`);
  });

  it('core that does not report a version yet (#284 pending)', async () => {
    expect(await probeApiMode(CORE, answer(200))).toEqual({ mode: 'core', contractsVersion: null });
  });

  it('Prism answers 404 on /health → mock', async () => {
    expect(await probeApiMode(CORE, answer(404))).toEqual({ mode: 'mock', contractsVersion: null });
  });

  it('a core answering 500 on /health is not the mock → unreachable', async () => {
    expect(await probeApiMode(CORE, answer(500))).toEqual({
      mode: 'unreachable',
      contractsVersion: null,
    });
    expect(await probeApiMode(CORE, answer(503))).toEqual({
      mode: 'unreachable',
      contractsVersion: null,
    });
  });

  it('nothing listening (or a timeout) → unreachable, not a throw', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await probeApiMode(CORE, down)).toEqual({ mode: 'unreachable', contractsVersion: null });
  });

  it('probes once a minute per base URL, not once per call', async () => {
    const fetchImpl = answer(200, { 'X-Contracts-Version': '0.4.6' });
    vi.stubGlobal('fetch', fetchImpl);
    await apiMode(CORE, 1_000);
    await apiMode(CORE, 30_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await apiMode(CORE, 61_001);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await apiMode('http://other.test', 61_002);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe('versionVerdict: warns, never blocks', () => {
  it.each<[string, ApiModeInfo, 'ok' | 'warning', RegExp]>([
    ['mock', { mode: 'mock', contractsVersion: null }, 'ok', /Prism mock · contracts 0\.4\.6/],
    [
      'matching core',
      { mode: 'core', contractsVersion: '0.4.6' },
      'ok',
      /Core · contracts 0\.4\.6/,
    ],
    [
      'older core',
      { mode: 'core', contractsVersion: '0.4.5' },
      'warning',
      /speaks contracts 0\.4\.5; this app was built for 0\.4\.6/,
    ],
    ['silent core', { mode: 'core', contractsVersion: null }, 'warning', /version unknown/],
    ['no answer', { mode: 'unreachable', contractsVersion: null }, 'warning', /did not answer/],
  ])('%s', (_label, info, tone, text) => {
    const verdict = versionVerdict(info, '0.4.6');
    expect(verdict.tone).toBe(tone);
    expect(verdict.text).toMatch(text);
  });

  it('a mismatch renders as a status line above the page, the page still renders', () => {
    render(
      <>
        <ApiModeNotice info={{ mode: 'core', contractsVersion: '0.0.1' }} />
        <p>the page</p>
      </>,
    );
    expect(screen.getByRole('status')).toHaveTextContent(/speaks contracts 0\.0\.1/);
    expect(screen.getByText('the page')).toBeInTheDocument();
  });

  it('a matching core is a quiet chip, not an alert', () => {
    render(<ApiModeNotice info={{ mode: 'core', contractsVersion: CONTRACTS_VERSION }} />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByText(/^Core · contracts/)).toBeInTheDocument();
  });
});

describe('not implemented vs session ended vs missing record (core only)', () => {
  const failed = (status: number, code: string): ApiResult<never> => ({
    ok: false,
    status,
    error: { code, message: 'x' } as AdminError,
  });
  const path = `/admin/stores/${STORE}/customers`;

  it('session ended: 401, and /admin/me with the same token is 401 too → stays 401', async () => {
    const me = vi.fn(async () => 401);
    const result = await reclassifyUnmounted(
      failed(401, 'unauthorized'),
      { method: 'GET', path },
      { mode: 'core', meStatus: me },
    );
    expect(result).toMatchObject({ ok: false, status: 401 });
    expect(me).toHaveBeenCalledTimes(1);
  });

  it('unmounted route before #265: 401 while /admin/me answers 200 → not_implemented naming the route', async () => {
    const result = await reclassifyUnmounted(
      failed(401, 'unauthorized'),
      { method: 'GET', path },
      { mode: 'core', meStatus: async () => 200 },
    );
    expect(result).toEqual({
      ok: false,
      status: 501,
      error: {
        code: 'not_implemented',
        message: 'The core does not serve GET /admin/stores/{id}/customers yet.',
        details: { route: 'GET /admin/stores/{id}/customers' },
      },
    });
  });

  it('unmounted route after #265: a 404 without the contract not_found code → not_implemented', async () => {
    const me = vi.fn(async () => 200);
    const result = await reclassifyUnmounted(
      failed(404, 'unknown'),
      { method: 'POST', path },
      { mode: 'core', meStatus: me },
    );
    expect(result).toMatchObject({
      status: 501,
      error: { details: { route: `POST /admin/stores/{id}/customers` } },
    });
    expect(me).not.toHaveBeenCalled();
  });

  it('a missing record (404 not_found on a single resource) stays a 404', async () => {
    const result = await reclassifyUnmounted(
      failed(404, 'not_found'),
      { method: 'GET', path: `${path}/${STORE}` },
      { mode: 'core', meStatus: async () => 200 },
    );
    expect(result).toMatchObject({ status: 404, error: { code: 'not_found' } });
  });

  it('since #308: 404 not_found on a collection read → not_implemented (a list has no record to miss)', async () => {
    const me = vi.fn(async () => 200);
    const result = await reclassifyUnmounted(
      failed(404, 'not_found'),
      { method: 'GET', path: `${path}?page=1` },
      { mode: 'core', meStatus: me },
    );
    expect(result).toMatchObject({
      status: 501,
      error: { code: 'not_implemented', details: { route: 'GET /admin/stores/{id}/customers' } },
    });
    expect(me).not.toHaveBeenCalled();
  });

  it("the core's own unmounted marker turns a single-resource 404 not_found into not_implemented", async () => {
    const result = await reclassifyUnmounted(
      {
        ok: false,
        status: 404,
        error: {
          code: 'not_found',
          message: `GET /admin/stores/${STORE}/customers/${STORE} is not implemented`,
          details: {},
        },
      },
      { method: 'GET', path: `${path}/${STORE}` },
      { mode: 'core', meStatus: async () => 200 },
    );
    expect(result).toMatchObject({
      status: 501,
      error: { details: { route: 'GET /admin/stores/{id}/customers/{id}' } },
    });
  });

  it('a collection 404 from Prism stays a 404', async () => {
    const result = await reclassifyUnmounted(
      failed(404, 'not_found'),
      { method: 'GET', path },
      { mode: 'mock', meStatus: async () => 200 },
    );
    expect(result.status).toBe(404);
  });

  it.each([
    ['GET', `/admin/stores/${STORE}/orders`, true],
    ['GET', `/admin/stores/${STORE}/orders?page=2`, true],
    ['GET', '/admin/stores', true],
    ['GET', `/admin/stores/${STORE}/orders/${STORE}`, false],
    ['GET', '/admin/pick-lists/42', false],
    ['GET', `/admin/stores/${STORE}`, false],
    ['POST', `/admin/stores/${STORE}/orders`, false],
  ] as const)('isCollectionRead(%s %s) = %s', (method, url, expected) => {
    expect(isCollectionRead(method, url)).toBe(expected);
  });

  it('against Prism nothing is reclassified, and /admin/me is not asked', async () => {
    const me = vi.fn(async () => 200);
    for (const [status, code] of [
      [401, 'unauthorized'],
      [404, 'unknown'],
    ] as const) {
      const result = await reclassifyUnmounted(
        failed(status, code),
        { method: 'GET', path },
        { mode: 'mock', meStatus: me },
      );
      expect(result.status).toBe(status);
    }
    expect(me).not.toHaveBeenCalled();
  });

  it('a 401 on /admin/me itself is always the session', async () => {
    const me = vi.fn(async () => 200);
    const result = await reclassifyUnmounted(
      failed(401, 'unauthorized'),
      { method: 'GET', path: '/admin/me' },
      { mode: 'core', meStatus: me },
    );
    expect(result.status).toBe(401);
    expect(me).not.toHaveBeenCalled();
  });

  it('labels fold ids and drop the query', () => {
    expect(routeLabel('get', `/admin/stores/${STORE}/orders/${STORE}?page=2`)).toBe(
      'GET /admin/stores/{id}/orders/{id}',
    );
  });

  it('labels fold numeric ids too, but not digits inside a segment', () => {
    expect(routeLabel('post', '/admin/pick-lists/42/lines/7')).toBe(
      'POST /admin/pick-lists/{id}/lines/{id}',
    );
    expect(routeLabel('get', '/admin/reports/v2/sales')).toBe('GET /admin/reports/v2/sales');
  });
});

describe('the not-implemented panel', () => {
  const error: AdminError = {
    code: 'not_implemented',
    message: 'The core does not serve GET /admin/stores/{id}/customers yet.',
    details: { route: 'GET /admin/stores/{id}/customers' },
  };

  it('ApiStatePanel names the route and does not say the session ended', () => {
    render(<ApiStatePanel status={501} error={error} what="Customers" />);
    expect(
      screen.getByRole('heading', { name: 'Not available on this API yet' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/does not serve GET \/admin\/stores\/\{id\}\/customers yet/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/sign in/i)).toBeNull();
  });

  it('RequestErrorPanel (used by cards that fail alone) renders the same panel', () => {
    render(<RequestErrorPanel status={501} error={error} />);
    expect(
      screen.getByRole('heading', { name: 'Not available on this API yet' }),
    ).toBeInTheDocument();
  });
});
