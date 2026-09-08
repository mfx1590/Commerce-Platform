// AlgoliaIndexClient request shaping against a fake fetch: batching, headers, browse cursor loop, settings,
// task polling, and the guarantee that the API key never appears in an error.
import { describe, expect, it } from 'vitest';
import { AlgoliaError, AlgoliaIndexClient } from './algolia-client';
import type { SearchRecord } from './types';

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (call: Call, n: number) => { status?: number; body?: unknown };

function fakeFetch(handler: Handler): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const r = handler(call, calls.length);
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetch: f, calls };
}

const record = (i: number): SearchRecord =>
  ({ objectID: `p${i}`, store_id: 's', handle: `h${i}`, title: `t${i}` }) as SearchRecord;

const KEY = 'secret-admin-key-123';

describe('AlgoliaIndexClient', () => {
  it('needs credentials and never puts them in the host', () => {
    expect(() => new AlgoliaIndexClient({ appId: '', apiKey: KEY })).toThrow();
    const { fetch } = fakeFetch(() => ({}));
    const c = new AlgoliaIndexClient({ appId: 'APP1', apiKey: KEY, fetch });
    expect(c).toBeInstanceOf(AlgoliaIndexClient);
  });

  it('saveObjects batches updateObject requests with the auth headers', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { taskID: 1 } }));
    const c = new AlgoliaIndexClient({ appId: 'APP1', apiKey: KEY, fetch, batchSize: 1000 });
    const records = Array.from({ length: 1500 }, (_, i) => record(i));
    await c.saveObjects('products_brand-a', records);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe('https://APP1.algolia.net/1/indexes/products_brand-a/batch');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers['X-Algolia-Application-Id']).toBe('APP1');
    expect(calls[0]!.headers['X-Algolia-API-Key']).toBe(KEY);
    const body = calls[0]!.body as { requests: { action: string; body: SearchRecord }[] };
    expect(body.requests).toHaveLength(1000);
    expect(body.requests[0]).toEqual({ action: 'updateObject', body: record(0) });
    expect((calls[1]!.body as { requests: unknown[] }).requests).toHaveLength(500);
  });

  it('deleteObjects sends deleteObject actions; index names are URL-encoded', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { taskID: 2 } }));
    const c = new AlgoliaIndexClient({ appId: 'APP1', apiKey: KEY, fetch });
    await c.deleteObjects('products/odd name', ['a', 'b']);
    expect(calls[0]!.url).toBe('https://APP1.algolia.net/1/indexes/products%2Fodd%20name/batch');
    expect(calls[0]!.body).toEqual({
      requests: [
        { action: 'deleteObject', body: { objectID: 'a' } },
        { action: 'deleteObject', body: { objectID: 'b' } },
      ],
    });
    await c.deleteObjects('x', []);
    expect(calls).toHaveLength(1); // nothing to send
  });

  it('browseObjectIDs follows the cursor until it is gone', async () => {
    const { fetch, calls } = fakeFetch((_call, n) =>
      n === 1
        ? { body: { hits: [{ objectID: 'a' }, { objectID: 'b' }], cursor: 'c1' } }
        : { body: { hits: [{ objectID: 'c' }] } },
    );
    const c = new AlgoliaIndexClient({ appId: 'APP1', apiKey: KEY, fetch });
    expect(await c.browseObjectIDs('idx')).toEqual(['a', 'b', 'c']);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body).toEqual({ attributesToRetrieve: [], hitsPerPage: 1000 });
    expect(calls[1]!.body).toEqual({ attributesToRetrieve: [], hitsPerPage: 1000, cursor: 'c1' });
  });

  it('getSettings treats a missing index as empty settings; setSettings is a PUT with forwardToReplicas', async () => {
    const { fetch, calls } = fakeFetch((call) =>
      call.method === 'GET'
        ? { status: 404, body: { message: 'Index idx does not exist' } }
        : { body: { taskID: 3 } },
    );
    const c = new AlgoliaIndexClient({ appId: 'APP1', apiKey: KEY, fetch });
    expect(await c.getSettings('idx')).toEqual({});
    await c.setSettings('idx', { userData: { outbox_cursor: 7 } }, { forwardToReplicas: true });
    expect(calls[1]!.method).toBe('PUT');
    expect(calls[1]!.url).toBe(
      'https://APP1.algolia.net/1/indexes/idx/settings?forwardToReplicas=true',
    );
    expect(calls[1]!.body).toEqual({ userData: { outbox_cursor: 7 } });
    await c.deleteIndex('idx');
    expect(calls[2]!.method).toBe('DELETE');
    expect(calls[2]!.url).toBe('https://APP1.algolia.net/1/indexes/idx');
  });

  it('errors carry status, path and the API message — never the key', async () => {
    const { fetch } = fakeFetch(() => ({
      status: 403,
      body: { message: `Invalid Application-ID or API key ${KEY}` },
    }));
    const c = new AlgoliaIndexClient({ appId: 'APP1', apiKey: KEY, fetch });
    const err = await c.saveObjects('idx', [record(1)]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlgoliaError);
    expect((err as AlgoliaError).status).toBe(403);
    expect((err as AlgoliaError).message).toContain('/1/indexes/idx/batch');
    expect((err as AlgoliaError).message).not.toContain(KEY);
    expect(JSON.stringify(err)).not.toContain(KEY);
  });

  it('waitForTasks polls the task until it is published', async () => {
    const { fetch, calls } = fakeFetch((call, n) => {
      if (call.method === 'PUT') return { body: { taskID: 42 } };
      return { body: { status: n < 4 ? 'notPublished' : 'published' } };
    });
    const c = new AlgoliaIndexClient({ appId: 'APP1', apiKey: KEY, fetch, waitForTasks: true });
    await c.setSettings('idx', { customRanking: [] });
    expect(calls.map((x) => x.method)).toEqual(['PUT', 'GET', 'GET', 'GET']);
    expect(calls[1]!.url).toBe('https://APP1.algolia.net/1/indexes/idx/task/42');
  });

  it('retries 5xx and 429 with backoff, then surfaces the last error; 4xx is final', async () => {
    const flaky = fakeFetch((_call, n) =>
      n === 1
        ? { status: 503, body: { message: 'unavailable' } }
        : n === 2
          ? { status: 429, body: { message: 'slow down' } }
          : { body: { taskID: 9 } },
    );
    const c = new AlgoliaIndexClient({
      appId: 'APP1',
      apiKey: KEY,
      fetch: flaky.fetch,
      retryBaseMs: 0,
    });
    await c.deleteObjects('idx', ['a']);
    expect(flaky.calls).toHaveLength(3);

    const dead = fakeFetch(() => ({ status: 502, body: { message: 'bad gateway' } }));
    const d = new AlgoliaIndexClient({
      appId: 'APP1',
      apiKey: KEY,
      fetch: dead.fetch,
      retries: 2,
      retryBaseMs: 0,
    });
    await expect(d.clearRules('idx')).rejects.toMatchObject({ status: 502 });
    expect(dead.calls).toHaveLength(3); // 1 + 2 retries

    const denied = fakeFetch(() => ({ status: 400, body: { message: 'nope' } }));
    const e = new AlgoliaIndexClient({
      appId: 'APP1',
      apiKey: KEY,
      fetch: denied.fetch,
      retryBaseMs: 0,
    });
    await expect(e.clearRules('idx')).rejects.toMatchObject({ status: 400 });
    expect(denied.calls).toHaveLength(1);

    const down = fakeFetch(() => {
      throw new Error(`ECONNRESET ${KEY}`);
    });
    const f = new AlgoliaIndexClient({
      appId: 'APP1',
      apiKey: KEY,
      fetch: down.fetch,
      retries: 1,
      retryBaseMs: 0,
    });
    const err = await f.clearRules('idx').catch((x: unknown) => x);
    expect(err).toBeInstanceOf(AlgoliaError);
    expect((err as AlgoliaError).message).not.toContain(KEY);
    expect(down.calls).toHaveLength(2);
  });

  it('masks every occurrence of the key in an error message', async () => {
    const { fetch } = fakeFetch(() => ({
      status: 403,
      body: { message: `${KEY} and again ${KEY}` },
    }));
    const c = new AlgoliaIndexClient({ appId: 'APP1', apiKey: KEY, fetch, retryBaseMs: 0 });
    const err = (await c.clearRules('idx').catch((x: unknown) => x)) as AlgoliaError;
    expect(err.message).not.toContain(KEY);
    expect(err.message.match(/\*\*\*/g)).toHaveLength(2);
  });

  it('saveRules replaces the set with clearExistingRules; search asks for objectIDs only', async () => {
    const { fetch, calls } = fakeFetch((call) =>
      call.url.endsWith('/query')
        ? { body: { hits: [{ objectID: 'p1', title: 'x' }], nbHits: 1, page: 0, hitsPerPage: 5 } }
        : { body: { taskID: 1 } },
    );
    const c = new AlgoliaIndexClient({ appId: 'APP1', apiKey: KEY, fetch, retryBaseMs: 0 });
    const rule = { objectID: 'merch_1', enabled: true, conditions: [], consequence: {} };
    await c.saveRules('idx', [rule], { clearExisting: true });
    expect(calls[0]!.url).toBe(
      'https://APP1.algolia.net/1/indexes/idx/rules/batch?clearExistingRules=true',
    );
    expect(calls[0]!.body).toEqual([rule]);
    await c.clearRules('idx');
    expect(calls[1]!.url).toBe('https://APP1.algolia.net/1/indexes/idx/rules/clear');
    const res = await c.search('idx', {
      query: 'tee',
      filters: 'category_id:c1',
      page: 0,
      hitsPerPage: 5,
    });
    expect(calls[2]!.body).toEqual({
      query: 'tee',
      filters: 'category_id:c1',
      page: 0,
      hitsPerPage: 5,
      attributesToRetrieve: ['objectID'],
    });
    expect(res).toEqual({ hits: [{ objectID: 'p1' }], nbHits: 1, page: 0, hitsPerPage: 5 });
  });
});
