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
const prism = resolve(
  dirname(require.resolve('@stoplight/prism-cli/package.json')),
  'dist/index.js',
);

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
    const child = spawn(
      process.execPath,
      [
        prism,
        'mock',
        resolve(here, '../openapi', spec),
        '--port',
        String(port),
        '--host',
        '127.0.0.1',
        '--errors',
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
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
    const list = await json(
      await fetch(`${STORE}/store/products?limit=24`, { headers: storeHeaders }),
    );
    expect(Array.isArray(list.items)).toBe(true);
    const one = await json(
      await fetch(`${STORE}/store/products/classic-tee`, { headers: storeHeaders }),
    );
    expect(one.handle).toBe('classic-tee');
    const variants = one.variants as Array<{ price: { amount_minor: number; currency: string } }>;
    expect(variants[0]?.price).toEqual({ amount_minor: 1999, currency: 'EUR' });
  });

  it('cart flow: create → add item → shipping options → payment session → complete', async () => {
    const created = await fetch(`${STORE}/store/carts`, {
      method: 'POST',
      headers: storeHeaders,
      body: '{}',
    });
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

    const ship = await json(
      await fetch(`${STORE}/store/carts/${cart.id}/shipping-options`, { headers: storeHeaders }),
    );
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
    const refund = await fetch(
      `${ADMIN}/admin/stores/${STORE_ID}/orders/30000000-0000-4000-8000-000000000501/refunds`,
      {
        method: 'POST',
        headers: { ...adminHeaders, [HEADERS.idempotencyKey]: 'refund-0001' },
        body: JSON.stringify({ amount_minor: 500, reason: 'goodwill' }),
      },
    );
    expect(refund.status).toBe(201);
  });

  it('marketing (0.3.0): create campaign → launch → attribution report; feed publish; review moderation', async () => {
    const base = `${ADMIN}/admin/stores/${STORE_ID}/marketing`;

    const created = await fetch(`${base}/campaigns`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        name: 'Autumn launch',
        type: 'paid_social',
        utm_source: 'meta',
        utm_medium: 'paid_social',
        utm_campaign: 'autumn-2026',
        budget: { amount_minor: 250000, currency: 'EUR' },
      }),
    });
    expect(created.status).toBe(201);
    const campaign = await json(created);
    expect(campaign.status).toBe('draft');
    expect(campaign.budget).toEqual({ amount_minor: 250000, currency: 'EUR' });

    const badType = await fetch(`${base}/campaigns`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ name: 'x', type: 'carrier_pigeon' }),
    });
    expect(badType.status).toBe(400);

    const launched = await fetch(`${base}/campaigns/${campaign.id}/launch`, {
      method: 'POST',
      headers: adminHeaders,
    });
    expect(launched.status).toBe(200);
    expect((await json(launched)).status).toBe('active');

    const report = await fetch(
      `${base}/reports/attribution?from=2026-09-01T00:00:00Z&to=2026-10-01T00:00:00Z&touch=last`,
      { headers: adminHeaders },
    );
    expect(report.status).toBe(200);
    const attribution = await json(report);
    expect(attribution.touch).toBe('last');
    const rows = attribution.items as Array<{
      campaign_id: string | null;
      revenue: { amount_minor: number; currency: string };
    }>;
    expect(rows[0]?.campaign_id).toBe(campaign.id);
    expect(rows[0]?.revenue.currency).toBe('EUR');
    const badTouch = await fetch(
      `${base}/reports/attribution?from=2026-09-01T00:00:00Z&to=2026-10-01T00:00:00Z&touch=mid`,
      { headers: adminHeaders },
    );
    expect(badTouch.status).toBe(400);
    const promotions = await fetch(
      `${base}/reports/promotions?from=2026-09-01T00:00:00Z&to=2026-10-01T00:00:00Z`,
      { headers: adminHeaders },
    );
    expect(promotions.status).toBe(200);

    const feed = await fetch(`${base}/feeds`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        name: 'Google Shopping NL',
        channel: 'google_merchant',
        locale: 'en-GB',
        currency: 'EUR',
      }),
    });
    expect(feed.status).toBe(201);
    const feedBody = await json(feed);
    expect(feedBody.status).toBe('draft');
    const published = await fetch(`${base}/feeds/${feedBody.id}/publish`, {
      method: 'POST',
      headers: adminHeaders,
    });
    expect(published.status).toBe(200);
    const publishedBody = await json(published);
    expect(publishedBody.status).toBe('active');
    expect(typeof publishedBody.url).toBe('string');
    const items = await json(
      await fetch(`${base}/feeds/${feedBody.id}/items?limit=20`, { headers: adminHeaders }),
    );
    expect(Array.isArray(items.items)).toBe(true);

    const queue = await json(
      await fetch(`${base}/reviews?status=pending`, { headers: adminHeaders }),
    );
    const pending = (queue.items as Array<{ id: string; status: string }>)[0]!;
    expect(pending.status).toBe('pending');
    const moderated = await fetch(`${base}/reviews/${pending.id}/moderate`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ status: 'published' }),
    });
    expect(moderated.status).toBe(200);
    expect((await json(moderated)).status).toBe('published');
    const badModeration = await fetch(`${base}/reviews/${pending.id}/moderate`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ status: 'deleted' }),
    });
    expect(badModeration.status).toBe(400);

    const preview = await fetch(`${base}/segments/70000000-0000-4000-8000-000000000721/preview`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        rules: { v: 1, all: [{ any: [{ field: 'consent', op: 'granted', value: 'email' }] }] },
      }),
    });
    expect(preview.status).toBe(200);
    expect(typeof (await json(preview)).count).toBe('number');

    // 0.4.4 (#239): the old flat shape is refused by the frozen grammar
    const flat = await fetch(`${base}/segments/70000000-0000-4000-8000-000000000721/preview`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ rules: { consent: ['email'] } }),
    });
    expect(flat.status).toBe(400);

    for (const p of [
      `/admin/marketing/dashboard?from=2026-09-01T00:00:00Z&to=2026-10-01T00:00:00Z`,
      `/admin/marketing/segment-templates`,
      `/admin/stores/${STORE_ID}/marketing/referral-programs`,
      `/admin/stores/${STORE_ID}/marketing/referrals`,
      `/admin/stores/${STORE_ID}/marketing/segments`,
    ]) {
      const res = await fetch(`${ADMIN}${p}`, { headers: adminHeaders });
      expect(res.status, p).toBe(200);
      await json(res);
    }
  });
});

describe('Admin API mock (0.4.0)', () => {
  it('merchandising (#162): create rule → publish → list; get / patch / delete; bad scope is 400', async () => {
    const base = `${ADMIN}/admin/stores/${STORE_ID}/merchandising`;
    const created = await fetch(`${base}/rules`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        scope: { type: 'category', category_id: '00000000-0000-4000-8000-000000000201' },
        pins: ['00000000-0000-4000-8000-000000000301'],
        boosts: [{ product_id: '00000000-0000-4000-8000-000000000302', weight: 50 }],
      }),
    });
    expect(created.status).toBe(201);
    const rule = await json(created);
    expect((rule.scope as { type: string }).type).toBe('category');
    expect(rule.published_at).toBeNull();

    const badScope = await fetch(`${base}/rules`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ scope: { type: 'brand' } }),
    });
    expect(badScope.status).toBe(400);
    const badWeight = await fetch(`${base}/rules`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        scope: { type: 'query', query: 'summer tee' },
        boosts: [{ product_id: '00000000-0000-4000-8000-000000000302', weight: 101 }],
      }),
    });
    expect(badWeight.status).toBe(400);

    const published = await fetch(`${base}/publish`, { method: 'POST', headers: adminHeaders });
    expect(published.status).toBe(200);
    const result = await json(published);
    expect(typeof result.index).toBe('string');
    expect(typeof result.published).toBe('number');
    expect(typeof result.skipped).toBe('number');

    const list = await json(await fetch(`${base}/rules`, { headers: adminHeaders }));
    const items = list.items as Array<{ id: string; scope: { type: string } }>;
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]?.scope.type).toBe('category');

    const one = await fetch(`${base}/rules/${rule.id}`, { headers: adminHeaders });
    expect(one.status).toBe(200);
    const patched = await fetch(`${base}/rules/${rule.id}`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ enabled: false }),
    });
    expect(patched.status).toBe(200);
    expect(typeof (await json(patched)).enabled).toBe('boolean');
    const badPatch = await fetch(`${base}/rules/${rule.id}`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ scope: { type: 'query', query: 'x' }, enabled: 'yes' }),
    });
    expect(badPatch.status).toBe(400);
    const deleted = await fetch(`${base}/rules/${rule.id}`, {
      method: 'DELETE',
      headers: adminHeaders,
    });
    expect(deleted.status).toBe(204);
  });

  it('401 / 403 are documented on every operation (#180): Prism can produce the refusal on demand', async () => {
    for (const [path, method, body] of [
      [`/admin/stores/${STORE_ID}/products`, 'POST', { handle: 'new-tee', title: 'New Tee' }],
      [`/admin/stores/${STORE_ID}/merchandising/publish`, 'POST', undefined],
      [`/admin/stores/${STORE_ID}/merchandising/rules`, 'GET', undefined],
    ] as const) {
      const forbidden = await fetch(`${ADMIN}${path}`, {
        method,
        headers: { ...adminHeaders, prefer: 'code=403' },
        body: body ? JSON.stringify(body) : undefined,
      });
      expect(forbidden.status, `${method} ${path}`).toBe(403);
      const err = await json(forbidden);
      expect(err.code).toBe('forbidden');
      expect(typeof (err.details as { relation: string }).relation).toBe('string');
    }
    const unauthorized = await fetch(`${ADMIN}/admin/stores/${STORE_ID}/products`, {
      headers: { ...adminHeaders, prefer: 'code=401' },
    });
    expect(unauthorized.status).toBe(401);
    expect((await json(unauthorized)).code).toBe('unauthorized');
  });
});

describe('Admin API mock (0.4.1)', () => {
  const PRODUCT_ID = '30000000-0000-4000-8000-000000000201';

  it('product media (#168): upload params → add (alt required) → move → list → delete', async () => {
    const params = await fetch(`${ADMIN}/admin/stores/${STORE_ID}/media/upload-params`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ product_id: PRODUCT_ID, filename: 'front.jpg' }),
    });
    expect(params.status).toBe(200);
    const signed = await json(params);
    expect(typeof signed.signature).toBe('string');
    expect(typeof signed.api_key).toBe('string');
    expect(signed).not.toHaveProperty('api_secret');
    expect((signed.params as { timestamp: number }).timestamp).toBe(signed.timestamp);
    const noProduct = await fetch(`${ADMIN}/admin/stores/${STORE_ID}/media/upload-params`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ filename: 'front.jpg' }),
    });
    expect(noProduct.status).toBe(400);

    const base = `${ADMIN}/admin/stores/${STORE_ID}/products/${PRODUCT_ID}/media`;
    const noAlt = await fetch(base, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ url: 'https://res.cloudinary.com/demo/image/upload/front.jpg' }),
    });
    expect(noAlt.status).toBe(400);
    const added = await fetch(base, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        url: 'https://res.cloudinary.com/demo/image/upload/front.jpg',
        alt: 'Classic Tee, front',
      }),
    });
    expect(added.status).toBe(201);
    const item = await json(added);
    expect(typeof item.position).toBe('number');
    expect(Object.keys(item.variants as object).sort()).toEqual(['pdp', 'thumb', 'zoom']);

    const moved = await fetch(`${base}/${item.id}`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ position: 2 }),
    });
    expect(moved.status).toBe(200);
    expect(typeof (await json(moved)).position).toBe('number');
    const badMove = await fetch(`${base}/${item.id}`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ position: -1 }),
    });
    expect(badMove.status).toBe(400);

    const list = await json(await fetch(base, { headers: adminHeaders }));
    const items = list.items as Array<{ position: number; variants: { thumb: string } }>;
    expect(items[0]?.position).toBe(0);
    expect(typeof items[0]?.variants.thumb).toBe('string');
    const deleted = await fetch(`${base}/${item.id}`, { method: 'DELETE', headers: adminHeaders });
    expect(deleted.status).toBe(204);
  });

  it('promotions (#189): create buy_x_get_y → get → update stackable; code / type stay out of the patch', async () => {
    const base = `${ADMIN}/admin/stores/${STORE_ID}/promotions`;
    const created = await fetch(base, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        name: 'Buy 2 tees get 1 free',
        type: 'buy_x_get_y',
        rules: { buy_quantity: 2, get_quantity: 1, get_discount_bp: 10000 },
        exclusive: true,
      }),
    });
    expect(created.status).toBe(201);
    const promotion = await json(created);
    expect(typeof promotion.stackable).toBe('boolean');
    expect(typeof promotion.exclusive).toBe('boolean');
    const badType = await fetch(base, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ name: 'x', type: 'bogo' }),
    });
    expect(badType.status).toBe(400);
    const badBundle = await fetch(base, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ name: 'x', type: 'buy_x_get_y', rules: { buy_quantity: 0 } }),
    });
    expect(badBundle.status).toBe(400);

    const one = await fetch(`${base}/${promotion.id}`, { headers: adminHeaders });
    expect(one.status).toBe(200);
    const got = await json(one);
    expect(got.type).toBe('buy_x_get_y');
    expect((got.rules as { buy_quantity: number }).buy_quantity).toBe(2);

    const updated = await fetch(`${base}/${promotion.id}`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ stackable: true, exclusive: false, status: 'disabled' }),
    });
    expect(updated.status).toBe(200);
    expect(typeof (await json(updated)).stackable).toBe('boolean');
    const badPatch = await fetch(`${base}/${promotion.id}`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ rules: { get_discount_bp: 20000 } }),
    });
    expect(badPatch.status).toBe(400);
  });

  it('feeds (#194): a feed whose publish failed is a schema-valid ProductFeed with status error', async () => {
    const base = `${ADMIN}/admin/stores/${STORE_ID}/marketing/feeds/70000000-0000-4000-8000-000000000731`;
    const failed = await fetch(`${base}/publish`, {
      method: 'POST',
      headers: { ...adminHeaders, prefer: 'example=googleError' },
    });
    expect(failed.status).toBe(200); // Prism validates the example against ProductFeed before answering
    const feed = await json(failed);
    expect(feed.status).toBe('error');
    expect(feed.url).toBeNull();
    expect((feed.errors as Array<{ code: string }>)[0]?.code).toBe('no_primary_domain');
    const read = await fetch(base, { headers: { ...adminHeaders, prefer: 'example=googleError' } });
    expect((await json(read)).status).toBe('error');
    // the input still cannot claim `error`: that verdict belongs to publishing
    const claimed = await fetch(`${ADMIN}/admin/stores/${STORE_ID}/marketing/feeds`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        name: 'x',
        channel: 'meta',
        locale: 'en-GB',
        currency: 'EUR',
        status: 'error',
      }),
    });
    expect(claimed.status).toBe(400);
  });
});

describe('Store API mock (0.3.0 currency query)', () => {
  it('accepts a valid currency and rejects a malformed one', async () => {
    const ok = await fetch(`${STORE}/store/products/classic-tee?currency=EUR`, {
      headers: storeHeaders,
    });
    expect(ok.status).toBe(200);
    const bad = await fetch(`${STORE}/store/products?currency=euros`, { headers: storeHeaders });
    expect(bad.status).toBe(400);
  });
});
