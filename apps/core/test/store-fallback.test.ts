// Integration 1 Store API fallback proxy (src/http/store-fallback.ts): a local http server plays the Prism mock
// and records what it received; the proxy must forward method, path + query, headers and body verbatim and
// return the upstream status, headers and body verbatim. No database: the proxy is mounted on a bare app.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
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
  app.use('/store', storeApiFallbackProxy(mockUrl, { log: (l) => lines.push(l) }));
  app.use(coreErrorHandler);
});

afterAll(async () => {
  await new Promise<void>((r) => mock.close(() => r()));
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

  it('answers 502 internal when the fallback is unreachable', async () => {
    const dead = express();
    dead.use('/store', storeApiFallbackProxy('http://127.0.0.1:9', { log: () => {} }));
    dead.use(coreErrorHandler);
    const res = await request(dead).get('/store/carts');
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ code: 'internal' });
  });

  it('is refused in production, both from the environment and as a mount option', () => {
    const prevEnv = process.env.NODE_ENV;
    const prevUrl = process.env.CORE_STORE_API_FALLBACK_URL;
    process.env.NODE_ENV = 'production';
    process.env.CORE_STORE_API_FALLBACK_URL = 'http://localhost:4010';
    try {
      expect(() => storeApiFallbackUrlFromEnv()).toThrow(/CORE_STORE_API_FALLBACK_URL/);
      expect(() =>
        mountCoreMiddleware(express(), undefined, { storeApiFallbackUrl: 'http://localhost:4010' }),
      ).toThrow(/CORE_STORE_API_FALLBACK_URL/);
      process.env.NODE_ENV = 'test';
      expect(storeApiFallbackUrlFromEnv()).toBe('http://localhost:4010');
      delete process.env.CORE_STORE_API_FALLBACK_URL;
      expect(storeApiFallbackUrlFromEnv()).toBeUndefined();
    } finally {
      process.env.NODE_ENV = prevEnv;
      if (prevUrl === undefined) delete process.env.CORE_STORE_API_FALLBACK_URL;
      else process.env.CORE_STORE_API_FALLBACK_URL = prevUrl;
    }
  });
});
