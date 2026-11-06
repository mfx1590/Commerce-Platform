// #729: the outbox envelope's `trace` carries the trace id of the request that wrote it. A withEvents call inside a
// request span writes that span's trace id (and the request id) into the outbox row; a trace the caller set is
// never overwritten; outside a request nothing is added. The insert is an `outbox.write` span under the request.
import { createOrganizationClient } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildEvent, withEvents } from '../src/outbox';
import { createStore } from '../src/modules/registry';
import {
  compileRouteMatcher,
  startTelemetry,
  telemetryMiddleware,
  type Telemetry,
} from '../src/telemetry';

const ORG = '72900000-0000-4000-8000-000000000001';
const LE = '72900000-0000-4000-8000-000000000011';

let db: TestDatabase;
let hq: ReturnType<typeof createOrganizationClient>;
let storeId: string;
let telemetry: Telemetry;
const spans = new InMemorySpanExporter();
const app = express();

const event = (trace?: { trace_id: string | null; request_id: string | null }) =>
  buildEvent({
    topic: 'store.updated',
    organizationId: ORG,
    storeId,
    aggregateType: 'store',
    aggregateId: storeId,
    payload: { store_id: storeId, code: 'brand-t', status: 'draft', changed_fields: ['name'] },
    ...(trace ? { trace } : {}),
  });

/** Writes one event in its own transaction and returns the row's `headers.trace`. */
async function writeAndRead(trace?: Parameters<typeof event>[0]): Promise<unknown> {
  const e = await event(trace);
  await hq.transaction(async (tx) => withEvents(tx, [e]));
  const { rows } = await hq.query<{ trace: unknown }>(
    `SELECT headers->'trace' AS trace FROM outbox WHERE id = $1`,
    [e.event_id],
  );
  return rows[0]!.trace;
}

beforeAll(async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  db = await createTestDatabase('core_outbox_trace');
  const owner = createOrganizationClient(db.owner, { organizationId: ORG });
  await owner.transaction(async (tx) => {
    await tx.query(`INSERT INTO organization (id, slug, name) VALUES ($1, 'hq', 'HQ')`, [ORG]);
    await tx.query(
      `INSERT INTO legal_entity (id, organization_id, code, name, country, currency) VALUES ($1, $2, 'le', 'LE', 'NL', 'EUR')`,
      [LE, ORG],
    );
  });
  hq = createOrganizationClient(db.app, { organizationId: ORG });
  storeId = (
    await createStore(hq, {
      legal_entity_id: LE,
      code: 'brand-t',
      name: 'Brand T',
      default_currency: 'EUR',
      default_locale: 'en-GB',
      default_country: 'NL',
    })
  ).id;

  telemetry = startTelemetry({}, { spanProcessor: new SimpleSpanProcessor({ exporter: spans }) });
  app.use(telemetryMiddleware({ routes: compileRouteMatcher(['/store/carts']) }));
  app.post('/store/carts', express.json(), async (req, res) => {
    const trace = (req.body as { trace?: Parameters<typeof event>[0] }).trace;
    res.status(201).json({ trace: await writeAndRead(trace) });
  });
}, 120_000);

afterAll(async () => {
  await telemetry?.shutdown();
  await db?.drop();
  vi.restoreAllMocks();
});

describe('the outbox envelope trace (#729)', () => {
  it("a withEvents call inside a request span writes that span's trace id and the request id", async () => {
    spans.reset();
    const res = await request(app)
      .post('/store/carts')
      .set('X-Request-Id', 'req-outbox-1')
      .send({})
      .expect(201);
    await new Promise((r) => setImmediate(r));
    const server = spans.getFinishedSpans().find((s) => s.name === 'POST /store/carts')!;
    const traceId = server.spanContext().traceId;
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(res.body.trace).toEqual({ trace_id: traceId, request_id: 'req-outbox-1' });
    const write = spans.getFinishedSpans().find((s) => s.name === 'outbox.write')!;
    expect(write.parentSpanContext?.spanId).toBe(server.spanContext().spanId);
    expect(write.attributes['outbox.events']).toBe(1);
  });

  it('never overwrites a trace the caller set', async () => {
    const callerTrace = { trace_id: null, request_id: 'set-by-caller' };
    const res = await request(app)
      .post('/store/carts')
      .set('X-Request-Id', 'req-outbox-2')
      .send({ trace: callerTrace })
      .expect(201);
    expect(res.body.trace).toEqual(callerTrace);
  });

  it('outside a request nothing is added (the row keeps the empty trace it always had)', async () => {
    expect(await writeAndRead()).toEqual({});
  });
});
