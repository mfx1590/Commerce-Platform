// HTTP tests (#360): /health and the staff-only preview over loopback, with a stub authenticator. The real
// dev-token path (an active staff_user) is covered in consumer.test.ts against the database.
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthError, type StaffAuth } from './auth.js';
import { brandProfile } from './brands.js';
import type { StoreTarget } from './consumer.js';
import { createNotificationsServer } from './server.js';

const auth: StaffAuth = {
  async authenticate(header) {
    if (header === 'Bearer staff-ok') return { subject: 'seed-owner' };
    throw new AuthError(401, 'nope');
  },
};
const stores: StoreTarget[] = [
  {
    id: '00000000-0000-4000-8000-000000000031',
    code: 'brand-a',
    defaultLocale: 'en-GB',
    timeZone: 'Europe/Amsterdam',
    legal: { name: 'Brand A B.V.', vatNumber: 'NL000000000B01' },
  },
];

let base = '';
const server = createNotificationsServer({
  auth,
  brands: (code) => brandProfile(code, {}),
  stores,
  status: () => ({ transport: 'dev', stores: ['brand-a'], last_run: null }),
  log: { info() {}, warn() {}, error() {} },
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const get = (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers });

describe('GET /health', () => {
  it('answers 200 with the worker status and never caches', async () => {
    const res = await get('/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      status: 'ok',
      transport: 'dev',
      stores: ['brand-a'],
      last_run: null,
    });
  });
});

describe('GET /preview/*', () => {
  it('is 401 without a staff token, and says so with WWW-Authenticate', async () => {
    const res = await get('/preview/order-confirmation?store=brand-a');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(await res.json()).toMatchObject({ code: 'unauthorized' });
    expect(
      (await get('/preview/order-confirmation', { authorization: 'Bearer wrong' })).status,
    ).toBe(401);
  });

  it('renders the fixture in the store default locale, or the requested one', async () => {
    const en = await get('/preview/order-confirmation?store=brand-a', {
      authorization: 'Bearer staff-ok',
    });
    expect(en.status).toBe(200);
    expect(en.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(en.headers.get('x-robots-tag')).toBe('noindex');
    const enBody = await en.text();
    expect(enBody).toContain('Your Brand A order #1042 is confirmed');
    expect(enBody).toContain('VAT no. NL000000000B01');

    const de = await get('/preview/shipment-shipped?store=brand-a&locale=de-DE', {
      authorization: 'Bearer staff-ok',
    });
    expect(de.status).toBe(200);
    expect(await de.text()).toContain('Ihre Bestellung #1042 bei Brand A ist unterwegs');

    const text = await get('/preview/order-confirmation?store=brand-a&format=text', {
      authorization: 'Bearer staff-ok',
    });
    expect(text.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await text.text()).toMatch(/^Subject: Your Brand A order #1042 is confirmed\n\nHi Ada,/);
  });

  it('refuses an unknown locale, store or kind', async () => {
    const h = { authorization: 'Bearer staff-ok' };
    expect((await get('/preview/order-confirmation?store=brand-a&locale=fr-FR', h)).status).toBe(
      400,
    );
    expect((await get('/preview/order-confirmation?store=brand-z', h)).status).toBe(404);
    expect((await get('/preview/order-confirmation', h)).status).toBe(404);
    expect((await get('/preview/password-reset?store=brand-a', h)).status).toBe(404);
    expect((await get('/nope', h)).status).toBe(404);
    expect((await fetch(base + '/health', { method: 'POST' })).status).toBe(405);
  });
});
