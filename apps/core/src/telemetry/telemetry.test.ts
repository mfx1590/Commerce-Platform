import { diag, SpanStatusCode } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace';
import type { ScopedClient } from '@platform/db';
import express from 'express';
import http from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadSpec } from '../http';
import type { StoreContext } from '../http/tenant';
import {
  compileRouteMatcher,
  currentTraceFields,
  knownStoreSet,
  samplerFromEnv,
  startTelemetry,
  telemetryActive,
  telemetryMiddleware,
  traceScopedClient,
  type Telemetry,
} from './index';

const STORE_A = '10000000-0000-4000-8000-00000000000a';
const KNOWN = '10000000-0000-4000-8000-00000000000b';
const UNKNOWN = '10000000-0000-4000-8000-0000000000ff';

const tick = () => new Promise((r) => setImmediate(r));

describe('route templates', () => {
  const routes = compileRouteMatcher([
    '/store/products/{handle}',
    '/store/products/search',
    '/admin/stores/{storeId}',
    '/admin/stores/{storeId}/products/{productId}',
  ]);

  it('maps a path to its template; a literal segment wins over a parameter; anything else is unmatched', () => {
    expect(routes.match('/store/products/red-shirt')).toEqual({
      template: '/store/products/{handle}',
      params: { handle: 'red-shirt' },
    });
    expect(routes.match('/store/products/search')?.template).toBe('/store/products/search');
    expect(routes.match(`/admin/stores/${KNOWN}/products/p1/`)).toEqual({
      template: '/admin/stores/{storeId}/products/{productId}',
      params: { storeId: KNOWN, productId: 'p1' },
    });
    expect(routes.match('/store/products')).toBeUndefined();
    expect(routes.match('/admin/stores/x/y')).toBeUndefined();
  });

  it('every path of both contracts matches itself, so no contract route is ever unmatched', () => {
    const paths = [
      ...Object.keys(loadSpec('store-api.yaml').doc.paths),
      ...Object.keys(loadSpec('admin-api.yaml').doc.paths),
    ];
    const contract = compileRouteMatcher(paths);
    expect(paths.length).toBeGreaterThan(100);
    for (const p of paths) {
      const concrete = p.replace(/\{[^}]+\}/g, 'x1');
      const m = contract.match(concrete);
      expect(m, p).toBeDefined();
      // a literal-only competitor may win (`/x/search` over `/x/{id}` for the value 'search'), never a raw path
      expect(m!.template.includes('x1')).toBe(false);
    }
    expect(contract.match(`/admin/stores/${KNOWN}`)?.template).toBe('/admin/stores/{storeId}');
  });
});

describe('known stores', () => {
  it('loads once, refreshes lazily after refreshMs, and keeps the last set when a load fails', async () => {
    let t = 0;
    let calls = 0;
    const load = vi.fn(async () => {
      calls++;
      if (calls === 2) throw new Error('db down');
      return calls === 1 ? [KNOWN] : [KNOWN, STORE_A];
    });
    const set = knownStoreSet(load, { refreshMs: 1000, now: () => t });
    await set.ready;
    expect(set.has(KNOWN)).toBe(true);
    expect(set.has(STORE_A)).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
    t = 1000;
    set.has(KNOWN); // triggers the failing load
    await tick();
    expect(set.has(KNOWN)).toBe(true); // kept
    t = 2000;
    set.has(KNOWN);
    await tick();
    expect(set.has(STORE_A)).toBe(true);
    expect(load).toHaveBeenCalledTimes(3);
  });
});

describe('sampler from OTEL_TRACES_SAMPLER', () => {
  it('maps the standard names', () => {
    expect(samplerFromEnv({})).toBeInstanceOf(AlwaysOnSampler);
    expect(samplerFromEnv({ OTEL_TRACES_SAMPLER: 'always_off' })).toBeInstanceOf(AlwaysOffSampler);
    expect(
      samplerFromEnv({
        OTEL_TRACES_SAMPLER: 'parentbased_traceidratio',
        OTEL_TRACES_SAMPLER_ARG: '0.1',
      }),
    ).toBeInstanceOf(TraceIdRatioBasedSampler);
  });
});

describe('off by default', () => {
  it('registers nothing without an endpoint, or with OTEL_SDK_DISABLED=true; the middleware is a pass-through', async () => {
    expect(startTelemetry({}).enabled).toBe(false);
    expect(
      startTelemetry({
        OTEL_SDK_DISABLED: 'true',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9',
      }).enabled,
    ).toBe(false);
    expect(telemetryActive()).toBe(false);
    const client = { scope: 'store' } as ScopedClient;
    expect(traceScopedClient(client)).toBe(client);
    const app = express();
    app.use(telemetryMiddleware({ routes: compileRouteMatcher([]) }));
    app.get('/x', (_req, res) => res.json(currentTraceFields() ?? null));
    const res = await request(app).get('/x').set('X-Request-Id', 'r-0');
    expect(res.body).toBeNull();
  });

  it('an absent collector is ONE warning, and the boot goes on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const t = startTelemetry({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9',
      OTEL_METRICS_EXPORTER: 'none',
    });
    try {
      expect(t.enabled).toBe(true);
      for (let i = 0; i < 60 && warn.mock.calls.length === 0; i++)
        await new Promise((r) => setTimeout(r, 50));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toMatch(
        /collector at http:\/\/127\.0\.0\.1:9\/v1\/traces is unreachable/,
      );
      diag.error('export failed again'); // what the SDK's error handler does on every later failure
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      await t.shutdown();
      vi.restoreAllMocks();
    }
    expect(telemetryActive()).toBe(false);
  });
});

describe('RED metrics and the SERVER span', () => {
  const spans = new InMemorySpanExporter();
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
  let telemetry: Telemetry;
  let app: express.Express;

  beforeAll(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    telemetry = startTelemetry(
      {},
      { spanProcessor: new SimpleSpanProcessor({ exporter: spans }), metricReader: reader },
    );
    app = express();
    app.use(
      telemetryMiddleware({
        routes: compileRouteMatcher([
          '/store/products/{handle}',
          '/store/carts',
          '/admin/stores/{storeId}',
        ]),
        knownStores: { has: (id) => id === KNOWN },
      }),
    );
    app.use('/store', (req, _res, next) => {
      req.tenant = { storeId: STORE_A } as StoreContext;
      next();
    });
    app.get('/store/products/:handle', (_req, res) => res.json({ ok: true }));
    // a body parser in between: its 'data'/'end' callbacks must stay in the request's context
    app.post('/store/carts', express.json(), (_req, res) =>
      res.status(201).json(currentTraceFields()),
    );
    app.get('/admin/stores/:storeId', (req, res) =>
      res.status(req.params.storeId === KNOWN ? 403 : 401).json({}),
    );
    app.get('/admin/boom', () => {
      throw new Error('boom');
    });
    app.get('/health', (_req, res) => res.send('OK'));
  });

  afterAll(async () => {
    await telemetry.shutdown();
    vi.restoreAllMocks();
  });

  it('labels by route template, method, status class and store_id only; 5xx is the only error', async () => {
    await request(app).get('/store/products/red-shirt?ref=email').expect(200);
    await request(app).get('/store/products/blue-shirt').expect(200);
    await request(app)
      .get(`/admin/stores/${KNOWN}`)
      .set('Authorization', 'Bearer dev:x')
      .expect(403);
    await request(app).get(`/admin/stores/${UNKNOWN}`).expect(401);
    await request(app).get('/admin/boom').expect(500);
    await request(app).get('/health').expect(200);
    await tick();
    await reader.forceFlush();
    const all = exporter.getMetrics().flatMap((r) => r.scopeMetrics.flatMap((s) => s.metrics));
    const byName = new Map(all.map((m) => [m.descriptor.name, m]));
    const points = (name: string) =>
      byName
        .get(name)!
        .dataPoints.map((d) => ({
          ...d.attributes,
          value: typeof d.value === 'number' ? d.value : (d.value as { count: number }).count,
        }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

    const expected = [
      {
        'http.route': '/admin/stores/{storeId}',
        'http.request.method': 'GET',
        'http.status_class': '4xx',
        store_id: 'none',
        value: 1,
      },
      {
        'http.route': '/admin/stores/{storeId}',
        'http.request.method': 'GET',
        'http.status_class': '4xx',
        store_id: KNOWN,
        value: 1,
      },
      {
        'http.route': '/store/products/{handle}',
        'http.request.method': 'GET',
        'http.status_class': '2xx',
        store_id: STORE_A,
        value: 2,
      },
      {
        'http.route': 'unmatched',
        'http.request.method': 'GET',
        'http.status_class': '5xx',
        store_id: 'none',
        value: 1,
      },
    ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    expect(points('core.http.requests')).toEqual(expected);
    expect(points('http.server.request.duration')).toEqual(expected);
    expect(byName.get('http.server.request.duration')!.descriptor.unit).toBe('s');
    expect(points('core.http.errors')).toEqual([
      {
        'http.route': 'unmatched',
        'http.request.method': 'GET',
        'http.status_class': '5xx',
        store_id: 'none',
        value: 1,
      },
    ]);
    // /health is probe traffic: no series, no span
    expect(JSON.stringify(all)).not.toContain('/health');
    expect(spans.getFinishedSpans().map((s) => s.name)).not.toContain('GET /health');
    const boom = spans.getFinishedSpans().find((s) => s.name === 'GET unmatched')!;
    expect(boom.status.code).toBe(SpanStatusCode.ERROR);
    const forbidden = spans.getFinishedSpans().find((s) => s.attributes.store_id === KNOWN)!;
    expect(forbidden.status.code).toBe(SpanStatusCode.UNSET); // a 4xx is not an error
  });

  it('the span is rooted here: an inbound traceparent is ignored, and the response gets no new header', async () => {
    spans.reset();
    const inbound = '0af7651916cd43dd8448eb211c80319c';
    const res = await request(app)
      .get('/store/products/red-shirt')
      .set('traceparent', `00-${inbound}-b7ad6b7169203331-01`)
      .expect(200);
    await tick();
    const [span] = spans.getFinishedSpans();
    expect(span!.name).toBe('GET /store/products/{handle}');
    expect(span!.spanContext().traceId).not.toBe(inbound);
    expect(span!.parentSpanContext).toBeUndefined();
    expect(res.headers.traceparent).toBeUndefined();
    expect(span!.attributes).toMatchObject({
      'http.route': '/store/products/{handle}',
      'http.response.status_code': 200,
      store_id: STORE_A,
    });
  });

  it('the handler runs in the span context, through a body parser: trace id and request id reach currentTraceFields', async () => {
    spans.reset();
    const res = await request(app)
      .post('/store/carts')
      .set('X-Request-Id', 'req-729')
      .send({ currency: 'EUR' })
      .expect(201);
    await tick();
    const [span] = spans.getFinishedSpans();
    expect(res.body).toEqual({ trace_id: span!.spanContext().traceId, request_id: 'req-729' });
  });

  it('a body that arrives after the headers (a later TCP read) still parses inside the request context', async () => {
    spans.reset();
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address() as { port: number };
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: '/store/carts',
            headers: { 'content-type': 'application/json', 'x-request-id': 'req-late' },
          },
          (res) => {
            let out = '';
            res.on('data', (c) => (out += c));
            res.on('end', () => resolve(out));
          },
        );
        req.on('error', reject);
        req.flushHeaders();
        setTimeout(() => req.end('{"currency":"EUR"}'), 100);
      });
      await tick();
      const [span] = spans.getFinishedSpans();
      expect(JSON.parse(body)).toEqual({
        trace_id: span!.spanContext().traceId,
        request_id: 'req-late',
      });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('a database transaction is a child span; a failure carries the SQLSTATE, never the message', async () => {
    spans.reset();
    const fake: ScopedClient = {
      scope: 'store',
      context: { organizationId: 'o', storeIds: [STORE_A] },
      transaction: async () => {
        throw Object.assign(new Error('Key (email)=(dora@example.test) already exists'), {
          code: '23505',
        });
      },
      query: async () => {
        throw new Error('unused');
      },
    };
    const traced = traceScopedClient(fake);
    const db = express();
    db.use(telemetryMiddleware({ routes: compileRouteMatcher(['/store/carts']) }));
    db.post('/store/carts', async (_req, res) => {
      await traced.transaction(async () => 1).catch(() => {});
      res.status(409).end();
    });
    await request(db).post('/store/carts').expect(409);
    await tick();
    const finished = spans.getFinishedSpans();
    const server = finished.find((s) => s.name === 'POST /store/carts')!;
    const tx = finished.find((s) => s.name === 'db.transaction')!;
    expect(tx.parentSpanContext?.spanId).toBe(server.spanContext().spanId);
    expect(tx.status.code).toBe(SpanStatusCode.ERROR);
    expect(tx.attributes).toMatchObject({
      'db.system.name': 'postgresql',
      'core.db.scope': 'store',
      'error.type': '23505',
    });
    expect(JSON.stringify(finished.map((s) => [s.attributes, s.events]))).not.toContain('dora');
  });
});
