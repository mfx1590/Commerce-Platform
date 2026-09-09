// The feed server: routing, the store-code scope, the path-traversal refusals and the production guard.
// No database, no docker stack — artifacts are written into a temp directory the way the core's publish job
// writes them.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFeedServer, parseFeedPath, resolveConfig } from './index.js';

const FEED_ID = '70000000-0000-4000-8000-000000000731';
const OTHER_FEED_ID = '70000000-0000-4000-8000-000000000732';
const XML = '<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"></rss>\n';
const CSV = 'id,title\r\nTEE-M-RED,Classic Tee\r\n';

let dir: string;
let server: Server;
let base: string;

async function get(path: string, method = 'GET') {
  const res = await fetch(`${base}${path}`, { method });
  return { status: res.status, headers: res.headers, body: await res.text() };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'feeds-app-'));
  await mkdir(join(dir, 'brand-a'), { recursive: true });
  await mkdir(join(dir, 'brand-b'), { recursive: true });
  await writeFile(join(dir, 'brand-a', `${FEED_ID}.xml`), XML, 'utf8');
  await writeFile(join(dir, 'brand-a', `${OTHER_FEED_ID}.csv`), CSV, 'utf8');
  // Present on disk but outside this instance's scope.
  await writeFile(join(dir, 'brand-b', `${FEED_ID}.xml`), XML, 'utf8');

  server = createFeedServer({ dir, storeCodes: ['brand-a'] });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

describe('serving feeds', () => {
  it('serves the XML feed with the right content type', async () => {
    const res = await get(`/feeds/brand-a/${FEED_ID}.xml`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(res.headers.get('cache-control')).toContain('max-age=');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(res.body).toBe(XML);
  });

  it('serves the CSV feed', async () => {
    const res = await get(`/feeds/brand-a/${OTHER_FEED_ID}.csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.body).toBe(CSV);
  });

  it('answers HEAD without a body, for crawlers checking freshness', async () => {
    const res = await get(`/feeds/brand-a/${FEED_ID}.xml`, 'HEAD');
    expect(res.status).toBe(200);
    expect(res.body).toBe('');
  });

  it('answers /health', async () => {
    const res = await get('/health');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
  });

  it('404s an unpublished feed', async () => {
    const res = await get('/feeds/brand-a/70000000-0000-4000-8000-000000000999.xml');
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).code).toBe('not_found');
  });
});

describe('refusals', () => {
  it('serves only its own store codes, and says nothing different about the others', async () => {
    const mine = await get(`/feeds/brand-a/${FEED_ID}.xml`);
    const theirs = await get(`/feeds/brand-b/${FEED_ID}.xml`);
    expect(mine.status).toBe(200);
    // The file exists on disk; this instance is not the one that serves it.
    expect(theirs.status).toBe(404);
    // Identical body to a genuinely missing feed: no probing which stores or feeds exist.
    const missing = await get('/feeds/brand-a/70000000-0000-4000-8000-000000000999.xml');
    expect(theirs.body).toBe(missing.body);
  });

  it('never lists a directory', async () => {
    expect((await get('/feeds/brand-a/')).status).toBe(404);
    expect((await get('/feeds/brand-a')).status).toBe(404);
    expect((await get('/feeds/')).status).toBe(404);
    expect((await get('/')).status).toBe(404);
  });

  it('refuses traversal and non-feed paths rather than sanitising them', async () => {
    for (const path of [
      '/feeds/../package.json',
      '/feeds/brand-a/..%2f..%2fpackage.json',
      `/feeds/../brand-b/${FEED_ID}.xml`,
      `/feeds/brand-a/${FEED_ID}.json`,
      '/feeds/brand-a/not-a-uuid.xml',
      `/feeds/BRAND-A/${FEED_ID}.xml`,
    ]) {
      expect((await get(path)).status, path).toBe(404);
    }
  });

  it('refuses a write method', async () => {
    expect((await get(`/feeds/brand-a/${FEED_ID}.xml`, 'DELETE')).status).toBe(405);
  });
});

describe('parseFeedPath', () => {
  it('accepts only <store_code>/<uuid>.<xml|csv> under /feeds', () => {
    expect(parseFeedPath(`/feeds/brand-a/${FEED_ID}.xml`)).toEqual({
      storeCode: 'brand-a',
      feedId: FEED_ID,
      extension: 'xml',
    });
    expect(parseFeedPath(`/feeds/brand-a/${FEED_ID}.CSV`)?.extension).toBe('csv');
    expect(parseFeedPath(`/feeds/brand-a/sub/${FEED_ID}.xml`)).toBeNull();
    expect(parseFeedPath(`/other/brand-a/${FEED_ID}.xml`)).toBeNull();
    expect(parseFeedPath('/feeds/brand-a/.xml')).toBeNull();
    expect(parseFeedPath(`/feeds/-bad/${FEED_ID}.xml`)).toBeNull();
  });
});

describe('resolveConfig', () => {
  it('defaults to the shared artifact directory and port 4020', () => {
    const config = resolveConfig({ NODE_ENV: 'development' } as NodeJS.ProcessEnv);
    expect(config).toMatchObject({ dir: '.feeds', port: 4020, storeCodes: [] });
  });

  it('parses the store-code allowlist', () => {
    const config = resolveConfig({
      FEEDS_STORE_CODES: 'brand-a, brand-b',
      PORT: '5000',
    } as NodeJS.ProcessEnv);
    expect(config.storeCodes).toEqual(['brand-a', 'brand-b']);
    expect(config.port).toBe(5000);
  });

  it('refuses to start in production without an allowlist', () => {
    expect(() => resolveConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(
      /FEEDS_STORE_CODES/,
    );
    expect(() =>
      resolveConfig({ NODE_ENV: 'production', FEEDS_STORE_CODES: 'brand-a' } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });
});
