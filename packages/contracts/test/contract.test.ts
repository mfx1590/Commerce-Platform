// Contract tests: boot the Prism mocks and prove the documented examples satisfy their own schemas
// (Prism validates every response against the spec and returns 500 when an example violates it).
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HEADERS } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const prism = resolve(dirname(require.resolve('@stoplight/prism-cli/package.json')), 'dist/index.js');

const STORE_PORT = 4110;
const ADMIN_PORT = 4111;
const STORE = `http://127.0.0.1:${STORE_PORT}`;
const ADMIN = `http://127.0.0.1:${ADMIN_PORT}`;
const STORE_ID = '00000000-0000-4000-8000-000000000031';
const storeHeaders = { [HEADERS.publishableKey]: 'pk_test', 'content-type': 'application/json' };
const adminHeaders = { authorization: 'Bearer test', 'content-type': 'application/json' };

const procs: ChildProcess[] = [];

function start(spec: string, port: number): Promise<void> {
  return new Promise((resolveStart, reject) => {
    const child = spawn(process.execPath, [prism, 'mock', resolve(here, '../openapi', spec), '--port', String(port), '--host', '127.0.0.1', '--errors'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    procs.push(child);
    let log = '';
    const onData = (d: Buffer) => {
      log += d.toString();
      if (/Prism is listening/.test(log)) resolveStart();
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('exit', (code) => reject(new Error(`prism ${spec} exited ${code}: ${log}`)));
    setTimeout(() => reject(new Error(`prism ${spec} did not start: ${log}`)), 40_000);
  });
}

beforeAll(async () => {
  await Promise.all([start('store-api.yaml', STORE_PORT), start('admin-api.yaml', ADMIN_PORT)]);
}, 60_000);

afterAll(() => {
  for (const p of procs) p.kill();
});

async function json(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`non-JSON ${res.status} body: ${text.slice(0, 300)}`);
  }
}

describe('Store API mock', () => {
  it('refuses requests without the publishable key', async () => {
    const res = await fetch(`${STORE}/store`);
    expect(res.status).toBe(401);
  });

  it('GET /store returns the example store', async () => {
    const res = await fetch(`${STORE}/store`, { headers: storeHeaders });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.code).toBe('brand-a');
    expect(body.id).toBe(STORE_ID);
  });

  it('GET /store/products and /store/products/{handle} conform to their schemas', async () => {
    const list = await json(await fetch(`${STORE}/store/products?limit=24`, { headers: storeHeaders }));
    expect(Array.isArray(list.items)).toBe(true);
    const one = await json(await fetch(`${STORE}/store/products/classic-tee`, { headers: storeHeaders }));
    expect(one.handle).toBe('classic-tee');
    const variants = one.variants as Array<{ price: { amount_minor: number; currency: string } }>;
    expect(variants[0]?.price).toEqual({ amount_minor: 1999, currency: 'EUR' });
  });

  it('cart flow: create → add item → shipping options → payment session → complete', async () => {
    const created = await fetch(`${STORE}/store/carts`, { method: 'POST', headers: storeHeaders, body: '{}' });
    expect(created.status).toBe(201);
    const cart = await json(created);
    expect(cart.items).toEqual([]);

    const add = await fetch(`${STORE}/store/carts/${cart.id}/line-items`, {
      method: 'POST',
      headers: storeHeaders,
      body: JSON.stringify({ variant_id: '30000000-0000-4000-8000-000000000301', quantity: 1 }),
    });
    expect(add.status).toBe(200);
    expect(((await json(add)).items as unknown[]).length).toBe(1);

    const bad = await fetch(`${STORE}/store/carts/${cart.id}/line-items`, {
      method: 'POST',
      headers: storeHeaders,
      body: JSON.stringify({ variant_id: 'nope', quantity: 0 }),
    });
    expect(bad.status).toBe(400); // Prism request validation

    const ship = await json(await fetch(`${STORE}/store/carts/${cart.id}/shipping-options`, { headers: storeHeaders }));
    expect((ship.items as unknown[]).length).toBeGreaterThan(0);

    const session = await fetch(`${STORE}/store/carts/${cart.id}/payment-session`, {
      method: 'POST',
      headers: storeHeaders,
      body: JSON.stringify({ provider: 'stripe' }),
    });
    expect(session.status).toBe(200);

    const complete = await fetch(`${STORE}/store/carts/${cart.id}/complete`, {
      method: 'POST',
      headers: { ...storeHeaders, [HEADERS.idempotencyKey]: 'test-key-0001' },
    });
    expect(complete.status).toBe(201);
    const order = await json(complete);
    expect(order.display_id).toBe(1000);
    expect((order.totals as { total: { amount_minor: number } }).total.amount_minor).toBe(2918);
  });
});

describe('Admin API mock', () => {
  it('refuses requests without a bearer token', async () => {
    expect((await fetch(`${ADMIN}/admin/me`)).status).toBe(401);
  });

  it('GET /admin/me returns the principal with store relations', async () => {
    const me = await json(await fetch(`${ADMIN}/admin/me`, { headers: adminHeaders }));
    const stores = me.stores as Array<{ relations: string[] }>;
    expect(stores[0]?.relations).toContain('store_admin');
  });

  it('registry, catalog, orders, inventory, roles, audit endpoints answer with schema-valid bodies', async () => {
    const paths = [
      `/admin/stores`,
      `/admin/stores/${STORE_ID}`,
      `/admin/stores/${STORE_ID}/products`,
      `/admin/stores/${STORE_ID}/products/30000000-0000-4000-8000-000000000201`,
      `/admin/stores/${STORE_ID}/price-lists`,
      `/admin/stores/${STORE_ID}/orders`,
      `/admin/stores/${STORE_ID}/orders/30000000-0000-4000-8000-000000000501`,
      `/admin/inventory/levels`,
      `/admin/stores/${STORE_ID}/shipping-options`,
      `/admin/stores/${STORE_ID}/customers`,
      `/admin/users`,
      `/admin/legal-entities`,
      `/admin/warehouses`,
      `/admin/audit-log`,
    ];
    for (const p of paths) {
      const res = await fetch(`${ADMIN}${p}`, { headers: adminHeaders });
      expect(res.status, p).toBe(200);
      await json(res);
    }
  });

  it('mutations validate their request bodies', async () => {
    const ok = await fetch(`${ADMIN}/admin/stores/${STORE_ID}/products`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ handle: 'new-tee', title: 'New Tee' }),
    });
    expect(ok.status).toBe(201);
    const bad = await fetch(`${ADMIN}/admin/stores/${STORE_ID}/products`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ handle: 'Not Kebab', title: 'x' }),
    });
    expect(bad.status).toBe(400);
    const refund = await fetch(`${ADMIN}/admin/stores/${STORE_ID}/orders/30000000-0000-4000-8000-000000000501/refunds`, {
      method: 'POST',
      headers: { ...adminHeaders, [HEADERS.idempotencyKey]: 'refund-0001' },
      body: JSON.stringify({ amount_minor: 500, reason: 'goodwill' }),
    });
    expect(refund.status).toBe(201);
  });
});
