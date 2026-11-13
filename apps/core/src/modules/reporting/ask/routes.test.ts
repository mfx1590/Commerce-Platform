// BI Q&A's routes (#606, contract #668) behind the real core middleware: dev tokens, the role_assignment stub, a
// seeded throwaway database for the scope and the per-store switch, a recording analytics reader, the scripted
// gateway and a memory feedback store. The operations' permissions are passed as CONTRACT CHANGE #668 states them
// until it lands (then admin-api.yaml carries them).
import express from 'express';
import request from 'supertest';
import { createOrganizationClient, SEED_IDS } from '@platform/db';
import type { TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { coreErrorHandler, DevTokenVerifier, moduleAdminRouters } from '../../../http';
import { closePool, initDb } from '../../../lib/db';
import { mountCoreMiddleware } from '../../../server';
import { createReportingDatabase } from '../testing/fixtures';
import type { MetricsReader } from '../metrics/execute';
import { createMemoryFeedbackStore, type MemoryFeedbackStore } from './feedback';
import { askAdminRouter } from './routes';
import { scriptedGateways, type ScriptStep } from './testing/fake-gateway';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const B = SEED_IDS.stores.brandB;
const C = SEED_IDS.stores.brandC;
const D = SEED_IDS.stores.brandD; // seeded since #832: every HQ principal sees it
const OPS: Record<string, { relation: string; object: string }> = {
  askMetrics: { relation: 'viewer', object: 'store:*' },
  askMetricsFeedback: { relation: 'viewer', object: 'store:*' },
};
const specWith = (ops: Record<string, { relation: string; object: string }>) => ({
  permission(op: string) {
    const p = ops[op];
    if (!p) throw new Error(`no operation ${op} in admin-api.yaml`);
    return p;
  },
  validateBody: () => {},
});

let db: TestDatabase;
let app: express.Express;
let script: ScriptStep[] = [];
let gateways = scriptedGateways([]);
let feedback: MemoryFeedbackStore;
let adminA: string;
const seen: { scope: unknown }[] = [];
const reader: MetricsReader = {
  async query({ query, query_params }) {
    if (query.includes('FROM raw_events')) return { json: async <T>() => [{ t: null }] as T[] };
    seen.push({ scope: query_params?.scope });
    const rows = ((query_params?.scope as string[]) ?? []).map((s) => ({
      out_period: '2026-10-01',
      out_currency: 'EUR',
      out_store: s,
      m_bookings_minor: 12_300,
    }));
    return { json: async <T>() => rows as T[] };
  },
};

const ask = (body: unknown, subject?: string) => {
  const r = request(app)
    .post('/admin/metrics/ask')
    .send(body as object);
  return subject ? r.set('Authorization', `Bearer dev:${subject}`) : r;
};
const rate = (conversationId: string, body: unknown, subject?: string) => {
  const r = request(app)
    .post(`/admin/metrics/ask/${conversationId}/feedback`)
    .send(body as object);
  return subject ? r.set('Authorization', `Bearer dev:${subject}`) : r;
};
const q = (extra: Record<string, unknown> = {}) => ({
  metrics: ['bookings_minor'],
  dimensions: ['store'],
  grain: 'total',
  from: '2026-10-01',
  to: '2026-11-01',
  ...extra,
});

beforeAll(async () => {
  process.env.CORE_DEV_TOKENS = '1';
  db = await createReportingDatabase('ask');
  await initDb({ connectionString: db.app.options.connectionString! });
  const hq = createOrganizationClient(db.app, { organizationId: ORG });
  // a store admin of brand A only (the seeded store-admin holds A and B)
  const user = await hq.query<{ id: string }>(
    `INSERT INTO staff_user (organization_id, keycloak_subject, email, display_name, status)
     VALUES ($1, 'ask-admin-a', 'ask-admin-a@example.test', 'Ask admin A', 'active') RETURNING id`,
    [ORG],
  );
  await hq.query(
    `INSERT INTO role_assignment (organization_id, staff_user_id, relation, object_type, object_id)
     VALUES ($1, $2, 'store_admin', 'store', $3)`,
    [ORG, user.rows[0]!.id, A],
  );
  feedback = createMemoryFeedbackStore((k) =>
    gateways.runs.some(
      (r) => r.conversationId === k.conversationId && r.scope.actorId === k.actorId,
    ),
  );
  adminA = user.rows[0]!.id;
  app = express();
  mountCoreMiddleware(app, new DevTokenVerifier(), {
    moduleRouters: [
      askAdminRouter({
        reader,
        spec: specWith(OPS),
        // each request's gateway plays the current script
        gatewayFor: (scope) => {
          gateways = scriptedGateways(script);
          return gateways(scope);
        },
        feedbackFor: () => feedback,
      }),
      ...moduleAdminRouters(),
    ],
  });
  app.use(coreErrorHandler);
}, 240_000);

afterAll(async () => {
  await closePool();
  await db?.drop();
});

beforeEach(() => {
  seen.length = 0;
  script = [
    { toolUse: [{ name: 'query_metrics', input: q() }] },
    { text: 'Bookings were €123.00 [q1].' },
  ];
});

describe('askMetrics', () => {
  it('401 without a token, and no model call', async () => {
    expect((await ask({ question: 'x' })).status).toBe(401);
  });

  it('a store admin of A: the answer cites the query, every statement scoped to A, charged to store A', async () => {
    const r = await ask({ question: 'bookings this month?' }, 'ask-admin-a');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      answer: 'Bookings were €123.00 [q1].',
      excluded_store_ids: [],
      template: { id: 'bi-qa-answer', version: 1 },
    });
    expect(r.body.queries[0].result.rows.map((x: { store_id: string }) => x.store_id)).toEqual([A]);
    for (const s of seen) expect(s.scope).toEqual([A]);
    expect(gateways.runs[0]!.scope.storeId).toBe(A);
  });

  it('store B in the body is a 403 naming it, before any model call (#606: store A asking about B)', async () => {
    const r = await ask({ question: 'refunds?', store_ids: [B] }, 'ask-admin-a');
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: 'forbidden', details: { object: `store:${B}` } });
    expect(seen).toEqual([]);
  });

  it('the scope check comes before the analytics store: store B is a 403, not a 503, while no read-only user is configured (#720 review)', async () => {
    const saved = process.env.CLICKHOUSE_READONLY_USER;
    delete process.env.CLICKHOUSE_READONLY_USER;
    try {
      // the production wiring: no injected reader, so the route would build the shared one
      const bare = express();
      mountCoreMiddleware(bare, new DevTokenVerifier(), {
        moduleRouters: [
          askAdminRouter({
            spec: specWith(OPS),
            gatewayFor: (scope) => {
              gateways = scriptedGateways(script);
              return gateways(scope);
            },
            feedbackFor: () => feedback,
          }),
        ],
      });
      bare.use(coreErrorHandler);
      const r = await request(bare)
        .post('/admin/metrics/ask')
        .set('Authorization', 'Bearer dev:ask-admin-a')
        .send({ question: 'refunds?', store_ids: [B] });
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ code: 'forbidden', details: { object: `store:${B}` } });
      expect(seen).toEqual([]);
    } finally {
      if (saved !== undefined) process.env.CLICKHOUSE_READONLY_USER = saved;
    }
  });

  it('the model asking for store B anyway gets a tool error; the analytics store is not read', async () => {
    script = [
      { toolUse: [{ name: 'query_metrics', input: q({ filters: { store_ids: [B] } }) }] },
      { text: 'I cannot read that store.' },
    ];
    const r = await ask({ question: 'how did brand-b do?' }, 'ask-admin-a');
    expect(r.status).toBe(200);
    expect(r.body.queries[0].error).toMatchObject({ code: 'forbidden' });
    expect(r.body.queries[0].result).toBeUndefined();
    expect(seen).toEqual([]);
  });

  it('an analyst asks over every store: the organization’s budget; a store switched off is left out and listed', async () => {
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    await hq.query(
      `UPDATE store SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{ai}', '{"bi_qa": false}') WHERE id = $1`,
      [C],
    );
    try {
      const r = await ask({ question: 'bookings by store?' }, 'seed-analyst');
      expect(r.status).toBe(200);
      expect(r.body.excluded_store_ids).toEqual([C]);
      for (const s of seen) expect((s.scope as string[]).sort()).toEqual([A, B].sort());
      expect(gateways.runs[0]!.scope.storeId).toBeNull();
    } finally {
      await hq.query(`UPDATE store SET settings = settings - 'ai' WHERE id = $1`, [C]);
    }
  });

  it('a bi_qa that is not a JSON boolean counts as ON (the owner default) and never fails the question', async () => {
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    await hq.query(
      `UPDATE store SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{ai}', '{"bi_qa": "no"}') WHERE id = $1`,
      [C],
    );
    await hq.query(
      `UPDATE store SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{ai}', '"not-an-object"') WHERE id = $1`,
      [B],
    );
    try {
      const r = await ask({ question: 'bookings by store?' }, 'seed-analyst');
      expect(r.status).toBe(200);
      expect(r.body.excluded_store_ids).toEqual([]);
      for (const s of seen) expect((s.scope as string[]).sort()).toEqual([A, B, C, D].sort());
    } finally {
      await hq.query(`UPDATE store SET settings = settings - 'ai' WHERE id = ANY($1::uuid[])`, [
        [B, C],
      ]);
    }
  });

  it('a store admin of two stores must name one (400 store_required); naming A is charged to store A', async () => {
    const none = await ask({ question: 'bookings?' }, 'seed-store-admin');
    expect(none.status).toBe(400);
    expect(none.body).toMatchObject({
      code: 'validation_error',
      details: { field: 'store_ids', reason: 'store_required' },
    });
    expect(seen).toEqual([]);
    const named = await ask({ question: 'bookings?', store_ids: [A] }, 'seed-store-admin');
    expect(named.status).toBe(200);
    expect(gateways.runs[0]!.scope.storeId).toBe(A);
    for (const s of seen) expect(s.scope).toEqual([A]);
  });

  it('the gateway’s rate limit is a 429 with Retry-After', async () => {
    script = [{ fail: 'AiRateLimitedError', details: { limit_per_minute: 10 } }];
    const r = await ask({ question: 'x' }, 'ask-admin-a');
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBe('60');
    expect(r.body).toMatchObject({ code: 'ai_rate_limited', details: { limit_per_minute: 10 } });
  });
});

describe('askMetricsFeedback', () => {
  it('the asker rates (204, the newest rating counts); anyone else gets 404; only up/down', async () => {
    const asked = await ask({ question: 'bookings?' }, 'ask-admin-a');
    const id = asked.body.conversation_id as string;
    expect((await rate(id, { rating: 'up' }, 'ask-admin-a')).status).toBe(204);
    expect((await rate(id, { rating: 'down' }, 'ask-admin-a')).status).toBe(204);
    const key = { organizationId: ORG, conversationId: id };
    expect(feedback.rows.filter((x) => x.conversationId === id).map((x) => x.rating)).toEqual([
      'up',
      'down',
    ]);
    const actor = feedback.rows.find((x) => x.conversationId === id)!.actorId;
    expect(feedback.latest({ ...key, actorId: actor })).toBe('down');

    const other = await rate(id, { rating: 'up' }, 'seed-analyst');
    expect(other.status).toBe(404);
    expect(
      (await rate('00000000-0000-4000-8000-00000000dead', { rating: 'up' }, 'ask-admin-a')).status,
    ).toBe(404);
    expect((await rate(id, { rating: 'meh' }, 'ask-admin-a')).status).toBe(400);
    expect((await rate('not-a-uuid', { rating: 'up' }, 'ask-admin-a')).status).toBe(400);
  });
});

describe('fail closed', () => {
  it('without the operations in the contract the route is 503 before anything runs; with them, the REAL gateway answers', async () => {
    const closed = express();
    mountCoreMiddleware(closed, new DevTokenVerifier(), {
      moduleRouters: [askAdminRouter({ reader, spec: specWith({}) })],
    });
    closed.use(coreErrorHandler);
    const a = await request(closed)
      .post('/admin/metrics/ask')
      .set('Authorization', 'Bearer dev:seed-owner')
      .send({ question: 'x' });
    expect([a.status, a.body.code]).toEqual([503, 'unavailable']);

    // no gatewayFor: production's packages/ai gateway. With AI_ENABLED unset it refuses at the kill switch — before
    // the limiter (Redis) or the provider — and still writes its audit row (ai_call_audit, purpose analysis)
    // counted before and after (#680 review): another test's disabled row of the organization cannot pass this one
    const disabledOrgRows = async () =>
      Number(
        (
          await createOrganizationClient(db.app, { organizationId: ORG }).query<{ n: string }>(
            "SELECT count(*) AS n FROM ai_call_audit WHERE purpose = 'analysis' AND outcome = 'disabled' AND store_id IS NULL",
          )
        ).rows[0]!.n,
      );
    const before = await disabledOrgRows();
    const previous = process.env.AI_ENABLED;
    delete process.env.AI_ENABLED;
    try {
      const real = express();
      mountCoreMiddleware(real, new DevTokenVerifier(), {
        moduleRouters: [askAdminRouter({ reader, spec: specWith(OPS) })],
      });
      real.use(coreErrorHandler);
      const b = await request(real)
        .post('/admin/metrics/ask')
        .set('Authorization', 'Bearer dev:seed-owner')
        .send({ question: 'x' });
      expect([b.status, b.body.code]).toEqual([503, 'ai_disabled']);
      expect(seen).toEqual([]);
      expect(await disabledOrgRows()).toBe(before + 1); // the owner: organization scope, exactly this request's row
    } finally {
      if (previous === undefined) delete process.env.AI_ENABLED;
      else process.env.AI_ENABLED = previous;
    }
  });
});

describe('askMetricsFeedback on ai_qa_feedback (0206, the production store)', () => {
  let pg: express.Express;
  const audit = async (conversation: string, storeId: string | null, actorId: string) => {
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    await hq.query(
      `INSERT INTO ai_call_audit (organization_id, store_id, actor_id, purpose, template_id, template_version,
         input_sha256, model, outcome, conversation_id, step, tool_names)
       VALUES ($1, $2, $3, 'analysis', 'bi-qa-answer', 1, repeat('a', 64), 'claude-sonnet-5-5', 'ok', $4, 0,
         '{query_metrics}')`,
      [ORG, storeId, actorId, conversation],
    );
  };
  const ratings = async (conversation: string) =>
    (
      await createOrganizationClient(db.app, { organizationId: ORG }).query<{
        store_id: string | null;
        rating: string;
      }>(
        'SELECT store_id, rating FROM ai_qa_feedback WHERE conversation_id = $1 ORDER BY created_at',
        [conversation],
      )
    ).rows;
  const ratePg = (id: string, rating: string, subject: string) =>
    request(pg)
      .post(`/admin/metrics/ask/${id}/feedback`)
      .set('Authorization', `Bearer dev:${subject}`)
      .send({ rating });

  beforeAll(() => {
    pg = express();
    // no feedbackFor: the Postgres store, through each caller's own tenant client
    mountCoreMiddleware(pg, new DevTokenVerifier(), {
      moduleRouters: [askAdminRouter({ reader, spec: specWith(OPS) })],
    });
    pg.use(coreErrorHandler);
  });

  it('a store question: its asker rates it, stored with the store; the newest row counts', async () => {
    const id = '00000000-0000-4000-8000-0000000fa001';
    await audit(id, A, adminA);
    expect((await ratePg(id, 'up', 'ask-admin-a')).status).toBe(204);
    expect((await ratePg(id, 'down', 'ask-admin-a')).status).toBe(204);
    expect(await ratings(id)).toEqual([
      { store_id: A, rating: 'up' },
      { store_id: A, rating: 'down' },
    ]);
  });

  it('an organization (HQ) question: stored with store_id NULL; a store admin cannot reach one, even as its actor', async () => {
    const analyst = (
      await createOrganizationClient(db.app, { organizationId: ORG }).query<{ id: string }>(
        "SELECT id FROM staff_user WHERE keycloak_subject = 'seed-analyst'",
      )
    ).rows[0]!.id;
    const hqId = '00000000-0000-4000-8000-0000000fa002';
    await audit(hqId, null, analyst);
    expect((await ratePg(hqId, 'up', 'seed-analyst')).status).toBe(204);
    expect(await ratings(hqId)).toEqual([{ store_id: null, rating: 'up' }]);
    // defence in depth: a store principal can no longer produce an organization row (#677: scope by principal), and
    // RLS hides one anyway — even a row naming them is a 404 to a store-scoped principal
    const odd = '00000000-0000-4000-8000-0000000fa003';
    await audit(odd, null, adminA);
    expect((await ratePg(odd, 'up', 'ask-admin-a')).status).toBe(404);
    expect(await ratings(odd)).toEqual([]);
  });

  it('a multi-store store admin rates their own answer: it is charged to the store they named (#677 review)', async () => {
    // the seeded store-admin holds brand A and brand B; their question names A, so its audit rows carry store A
    const storeAdmin = (
      await createOrganizationClient(db.app, { organizationId: ORG }).query<{ id: string }>(
        "SELECT id FROM staff_user WHERE keycloak_subject = 'seed-store-admin'",
      )
    ).rows[0]!.id;
    const id = '00000000-0000-4000-8000-0000000fa005';
    await audit(id, A, storeAdmin);
    expect((await ratePg(id, 'up', 'seed-store-admin')).status).toBe(204);
    expect(await ratings(id)).toEqual([{ store_id: A, rating: 'up' }]);
  });

  it('another principal’s conversation is a 404 and nothing is stored', async () => {
    const id = '00000000-0000-4000-8000-0000000fa004';
    await audit(id, A, adminA);
    expect((await ratePg(id, 'up', 'seed-analyst')).status).toBe(404);
    expect(await ratings(id)).toEqual([]);
  });
});
