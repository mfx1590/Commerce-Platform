// Integration 1 Store API fallback proxy (src/http/store-fallback.ts): a local http server plays the Prism mock
// and records what it received; the proxy must forward method, path + query, headers and body verbatim and
// return the upstream status, headers and body verbatim. No database: the proxy is mounted on a bare app.
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreErrorHandler, storeApiFallbackProxy } from '../src/http';
import { mountCoreMiddleware, storeApiFallbackUrlFromEnv } from '../src/server';

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let mock: http.Server;
let mockUrl: string;
let seen: Seen[] = [];
let lines: string[] = [];
let app: express.Express;

beforeAll(async () => {
  mock = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({
        method: req.method!,
        url: req.url!,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      if (req.url === '/store/carts/missing') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 'not_found', message: 'cart missing not found' }));
        return;
      }
      res.writeHead(201, {
        'content-type': 'application/json; charset=utf-8',
        'x-mock': 'prism',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify({ id: 'cart_1', echo: req.method }));
    });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  mockUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/`; // trailing slash tolerated
  app = express();
  app.get('/store/products', (_req, res) => res.json({ real: true }));
  // Same shape as src/server.ts since 2.1: a JSON body parser sits on /store/carts ahead of the proxy.
  app.use('/store/carts', express.json());
  app.use('/store', storeApiFallbackProxy(mockUrl, { log: (l) => lines.push(l) }));
  app.use(coreErrorHandler);
});

afterAll(async () => {
  await new Promise<void>((r) => mock.close(() => r()));
});

describe('body already parsed by express.json (review nit, #157)', () => {
  it('re-serialises req.body so the mock receives the same JSON document and content-type', async () => {
    seen = [];
    const payload = { provider: 'manual', nested: { n: 1, list: ['a', 'b'] }, note: 'ünïcödé' };
    const res = await request(app)
      .post('/store/carts/00000000-0000-4000-8000-000000000001/payment-session')
      .set('X-Publishable-Key', 'pk')
      .set('Content-Type', 'application/json')
      .send(payload);
    expect(res.status).toBe(201);
    const up = seen[0]!;
    expect(up.method).toBe('POST');
    expect(up.url).toBe('/store/carts/00000000-0000-4000-8000-000000000001/payment-session');
    expect(JSON.parse(up.body)).toEqual(payload);
    expect(up.headers['content-type']).toBe('application/json');
    expect(up.headers['x-publishable-key']).toBe('pk');
  });
});

describe('storeApiFallbackProxy', () => {
  it('forwards a POST verbatim (method, path + query, headers, body) and returns the upstream response verbatim', async () => {
    seen = [];
    lines = [];
    const res = await request(app)
      .post('/store/carts?region=eu&x=1')
      .set('X-Publishable-Key', 'pk_brand-a_dev_00000000000000000000')
      .set('Authorization', 'Bearer customer-token')
      .set('Idempotency-Key', 'idem-123')
      .set('Content-Type', 'application/json')
      .send({ currency: 'EUR', items: [{ variant_id: 'v1', quantity: 2 }] });

    expect(seen).toHaveLength(1);
    const up = seen[0]!;
    expect(up.method).toBe('POST');
    expect(up.url).toBe('/store/carts?region=eu&x=1');
    expect(up.headers['x-publishable-key']).toBe('pk_brand-a_dev_00000000000000000000');
    expect(up.headers.authorization).toBe('Bearer customer-token');
    expect(up.headers['idempotency-key']).toBe('idem-123');
    expect(up.headers['content-type']).toBe('application/json');
    expect(JSON.parse(up.body)).toEqual({
      currency: 'EUR',
      items: [{ variant_id: 'v1', quantity: 2 }],
    });

    expect(res.status).toBe(201);
    expect(res.headers['x-mock']).toBe('prism');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.body).toEqual({ id: 'cart_1', echo: 'POST' });

    expect(lines).toEqual(['[core] store api fallback → POST /store/carts']);
    expect(lines[0]).not.toContain('pk_brand-a');
    expect(lines[0]).not.toContain('region=');
  });

  it('forwards GET without a body, passes upstream errors through, and never touches the real routes', async () => {
    seen = [];
    const notFound = await request(app).get('/store/carts/missing').set('X-Publishable-Key', 'pk');
    expect(notFound.status).toBe(404);
    expect(notFound.body).toEqual({ code: 'not_found', message: 'cart missing not found' });
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/store/carts/missing', body: '' });

    const real = await request(app).get('/store/products');
    expect(real.body).toEqual({ real: true });
    expect(seen).toHaveLength(1);
  });

  it('rejects dot segments so nothing outside /store can be reached through the proxy', async () => {
    const before = seen.length;
    // supertest normalises the path, so send the raw request line ourselves.
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const status = await new Promise<number>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write(
          ['GET /store/../admin/me HTTP/1.1', 'Host: x', 'Connection: close', '', ''].join('\r\n'),
        );
      });
      let data = '';
      socket.on('data', (c: Buffer) => (data += c.toString()));
      socket.on('end', () => resolve(Number(data.split(' ')[1])));
      socket.on('error', reject);
    });
    await new Promise<void>((r) => server.close(() => r()));
    expect(status).toBe(400);
    expect(seen.length).toBe(before);
  });

  it('answers 502 internal when the fallback is unreachable', async () => {
    const dead = express();
    dead.use('/store', storeApiFallbackProxy('http://127.0.0.1:9', { log: () => {} }));
    dead.use(coreErrorHandler);
    const res = await request(dead).get('/store/carts');
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ code: 'internal' });
  });

  it('is refused in production unconditionally, before the opt-in flag is consulted', () => {
    const prod = { NODE_ENV: 'production' } as const;
    // flag alone, url alone, both: every combination refuses; nothing set is simply off.
    expect(() => storeApiFallbackUrlFromEnv({ ...prod, CORE_STORE_API_FALLBACK: '1' })).toThrow(
      /must not be set in production/,
    );
    expect(() =>
      storeApiFallbackUrlFromEnv({ ...prod, CORE_STORE_API_FALLBACK_URL: 'http://localhost:4010' }),
    ).toThrow(/must not be set in production/);
    expect(() =>
      storeApiFallbackUrlFromEnv({
        ...prod,
        CORE_STORE_API_FALLBACK: '1',
        CORE_STORE_API_FALLBACK_URL: 'http://localhost:4010',
      }),
    ).toThrow(/must not be set in production/);
    expect(storeApiFallbackUrlFromEnv({ ...prod })).toBeUndefined();
    // the mount option is refused too, independently of the environment variables
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() =>
        mountCoreMiddleware(express(), undefined, { storeApiFallbackUrl: 'http://localhost:4010' }),
      ).toThrow(/must not be set in production/);
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });

  it('outside production it needs the explicit CORE_STORE_API_FALLBACK=1 opt-in AND the url', () => {
    const dev = { NODE_ENV: 'test' } as const;
    expect(storeApiFallbackUrlFromEnv({ ...dev })).toBeUndefined();
    // the url alone does not switch the proxy on
    expect(
      storeApiFallbackUrlFromEnv({ ...dev, CORE_STORE_API_FALLBACK_URL: 'http://localhost:4010' }),
    ).toBeUndefined();
    expect(
      storeApiFallbackUrlFromEnv({
        ...dev,
        CORE_STORE_API_FALLBACK: 'yes',
        CORE_STORE_API_FALLBACK_URL: 'http://localhost:4010',
      }),
    ).toBeUndefined();
    // the flag without a target is a configuration error, not a silent no-op
    expect(() => storeApiFallbackUrlFromEnv({ ...dev, CORE_STORE_API_FALLBACK: '1' })).toThrow(
      /requires CORE_STORE_API_FALLBACK_URL/,
    );
    expect(
      storeApiFallbackUrlFromEnv({
        ...dev,
        CORE_STORE_API_FALLBACK: '1',
        CORE_STORE_API_FALLBACK_URL: 'http://localhost:4010',
      }),
    ).toBe('http://localhost:4010');
  });
});
