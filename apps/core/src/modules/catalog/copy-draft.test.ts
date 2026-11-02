// AI copy drafts (#608, CONTRACT CHANGE #664) on a seeded throwaway database and the gateway's DETERMINISTIC FAKE —
// no network, no key. The product is read on store-scoped clients; the draft is never written to the product.
import {
  AiAuditError,
  AiConfigError,
  AiLimiterError,
  createAiGateway,
  createFakeTransport,
  DeniedFieldError,
  TemplateError,
  createMemoryAuditSink,
  createMemoryLimiter,
  createPgAuditSink,
  type AiResponse,
  type Limits,
} from '@platform/ai';
import { createOrganizationClient, createTenantClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../lib/errors';
import { toAppError } from './copy-draft';
import {
  COPY_TEMPLATE,
  DEFAULT_BRAND_VOICE,
  draftProductCopy,
  parseDraft,
  setCopyDraftGatewayFactory,
  type CopyDraftGatewayFactory,
} from './index';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const B = SEED_IDS.stores.brandB;
const STAFF = SEED_IDS.users.operations;

let db: TestDatabase;
let a: ReturnType<typeof createTenantClient>;
let owner: ReturnType<typeof createOrganizationClient>;
let productA: string;
let productB: string;
let previous: CopyDraftGatewayFactory;

/** What template @2 answers: ONE strict-JSON object (the fake returns it for every request). */
const ANSWER = JSON.stringify({
  title: 'Linen tea towel',
  description: 'A tea towel of pure linen that dries quickly.\n\nIt softens with every wash.',
  bullets: ['100% linen', '50 x 70 cm'],
  seo: { title: 'Linen tea towel', description: 'A tea towel of pure linen.' },
});

/** A fake gateway per test: the fake transport (records every request), memory limiter and audit sink. */
function fake(
  opts: {
    answer?: Partial<AiResponse> | Error;
    env?: NodeJS.ProcessEnv;
    limits?: Limits;
    audit?: ReturnType<typeof createMemoryAuditSink> | ReturnType<typeof createPgAuditSink>;
  } = {},
) {
  const transport = createFakeTransport(() =>
    opts.answer instanceof Error ? opts.answer : { text: ANSWER, ...opts.answer },
  );
  const audit = opts.audit ?? createMemoryAuditSink();
  const limiter = createMemoryLimiter();
  setCopyDraftGatewayFactory((ctx) =>
    createAiGateway({
      ...ctx,
      purpose: 'drafting',
      transport,
      limiter,
      audit,
      env: opts.env ?? { AI_ENABLED: '1' },
      ...(opts.limits ? { limits: opts.limits } : {}),
    }),
  );
  return { transport, audit };
}

const draft = (fields: string[], locale = 'de-DE', productId = productA) =>
  draftProductCopy(a, A, { productId, locale, fields, actorId: STAFF });

beforeAll(async () => {
  db = await createTestDatabase('core_copy_draft');
  await seed(db.owner, { productsPerStore: 4, log: () => {} });
  owner = createOrganizationClient(db.owner, { organizationId: ORG });
  a = createTenantClient(db.app, { organizationId: ORG, storeIds: [A] });
  const first = async (storeId: string) =>
    (
      await owner.query<{ id: string }>(
        `SELECT id FROM product WHERE store_id = $1 ORDER BY handle LIMIT 1`,
        [storeId],
      )
    ).rows[0]!.id;
  productA = await first(A);
  productB = await first(B);
  previous = setCopyDraftGatewayFactory(() => {
    throw new Error('no test may reach the real gateway');
  });
}, 180_000);

afterEach(() => {
  setCopyDraftGatewayFactory(() => {
    throw new Error('no test may reach the real gateway');
  });
});

afterAll(async () => {
  setCopyDraftGatewayFactory(previous);
  await db?.drop();
});

describe('draftProductCopy (#608): a draft, never saved', () => {
  it('returns exactly the requested fields with the model and template; the product row is unchanged', async () => {
    const before = await owner.query(
      `SELECT title, description, seo, updated_at FROM product WHERE id = $1`,
      [productA],
    );
    const { transport, audit } = fake();
    const res = await draft(['description', 'bullets']);
    expect(res).toMatchObject({
      product_id: productA,
      locale: 'de-DE',
      fields: ['description', 'bullets'],
      draft: {
        description: 'A tea towel of pure linen that dries quickly.\n\nIt softens with every wash.',
        bullets: ['100% linen', '50 x 70 cm'],
      },
      brand_voice_source: 'default',
      model: 'claude-sonnet-5-5',
      template: { id: COPY_TEMPLATE.id, version: COPY_TEMPLATE.version },
    });
    expect(Object.keys(res.draft).sort()).toEqual(['bullets', 'description']);
    // the model saw the product's own facts, the locale and the default voice — one request, one audit row
    expect(transport.calls).toHaveLength(1);
    const sent = transport.calls[0]!.user;
    const title = (
      await owner.query<{ title: string }>(`SELECT title FROM product WHERE id = $1`, [productA])
    ).rows[0]!.title;
    expect(sent).toContain(title);
    expect(sent).toContain('de-DE');
    expect(sent).toContain(DEFAULT_BRAND_VOICE);
    expect(sent).toContain('Requested keys: description, bullets'); // @2's `fields` variable
    expect((audit as ReturnType<typeof createMemoryAuditSink>).records).toHaveLength(1);
    // never written: the row is byte-for-byte what it was
    const after = await owner.query(
      `SELECT title, description, seo, updated_at FROM product WHERE id = $1`,
      [productA],
    );
    expect(after.rows).toEqual(before.rows);
  });

  it('the brand voice and audience come from store.settings.content when set', async () => {
    await owner.query(
      `UPDATE store SET settings = jsonb_set(settings, '{content}', '{"brand_voice":"Dry wit, short sentences.","audience":"home cooks"}'::jsonb) WHERE id = $1`,
      [A],
    );
    try {
      const { transport } = fake();
      const res = await draft(['description']);
      expect(res.brand_voice_source).toBe('settings');
      expect(transport.calls[0]!.user).toContain('Dry wit, short sentences.');
      expect(transport.calls[0]!.user).toContain('home cooks');
    } finally {
      await owner.query(`UPDATE store SET settings = settings - 'content' WHERE id = $1`, [A]);
    }
  });

  it('no customer data reaches the model: the rendered <facts> block is exactly the product\u2019s own facts', async () => {
    await owner.query(
      `INSERT INTO customer (id, organization_id, store_id, email, phone, status)
       VALUES ('00000000-0000-4000-8000-00000000c608', $1, $2, 'copy-draft-customer@example.com', '+31612345678', 'registered')`,
      [ORG, A],
    );
    // a product of brand A with known facts: subtitle, brand, tags, two scalar attributes and one nested (dropped),
    // no category, one option
    const product = (
      await owner.query<{ id: string }>(
        `SELECT id FROM product WHERE store_id = $1 ORDER BY handle OFFSET 1 LIMIT 1`,
        [A],
      )
    ).rows[0]!.id;
    await owner.query(
      `UPDATE product SET subtitle = 'Soft linen', brand_name = 'Brand A', tags = '{kitchen,linen}',
         category_id = NULL, attributes = '{"material":"linen","size_cm":"50 x 70","care":{"wash":40}}'::jsonb
       WHERE id = $1`,
      [product],
    );
    await owner.query(`DELETE FROM product_option WHERE product_id = $1`, [product]);
    await owner.query(
      `INSERT INTO product_option (organization_id, store_id, product_id, name, values, position)
       VALUES ($1, $2, $3, 'Size', '{S,M}', 0)`,
      [ORG, A, product],
    );
    const { transport } = fake();
    await draft(['description'], 'de-DE', product);
    const user = transport.calls[0]!.user;
    // jsonb keeps object keys shortest-first, so size_cm comes before material; the nested `care` never goes out
    expect(user.slice(user.indexOf('<facts>'), user.indexOf('</facts>') + '</facts>'.length)).toBe(
      [
        '<facts>',
        'subtitle: Soft linen',
        'brand: Brand A',
        'tags: kitchen, linen',
        'size_cm: 50 x 70',
        'material: linen',
        'Size: S, M',
        '</facts>',
      ].join('\n'),
    );
    const sent = `${transport.calls[0]!.system}\n${user}`;
    expect(sent).not.toContain('copy-draft-customer@example.com');
    expect(sent).not.toContain('612345678');
  });

  it('400 for a locale the store does not use or bad fields; 404 for another store’s product', async () => {
    fake();
    await expect(draft(['description'], 'ja-JP')).rejects.toMatchObject({
      code: 'validation_error',
      details: { locale: 'a locale enabled for the store' },
    });
    await expect(draft([])).rejects.toMatchObject({ code: 'validation_error' });
    await expect(draft(['tagline'])).rejects.toMatchObject({ code: 'validation_error' });
    await expect(draft(['description'], 'de-DE', productB)).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
  });

  it('title and seo come back only when asked; a cut-off, non-JSON or incomplete answer → 502 ai_invalid_draft', async () => {
    fake();
    const res = await draft(['title', 'seo']);
    expect(res.draft).toEqual({
      title: 'Linen tea towel',
      seo: { title: 'Linen tea towel', description: 'A tea towel of pure linen.' },
    });
    // cut off at max_tokens: refused before any parsing, even when the text happens to parse (#665 review)
    fake({ answer: { stopReason: 'max_tokens' } });
    await expect(draft(['description'])).rejects.toMatchObject({
      code: 'ai_invalid_draft',
      status: 502,
      details: { reason: 'truncated' },
    });
    fake({ answer: { text: 'Here is your copy: a linen tea towel.' } });
    await expect(draft(['description'])).rejects.toMatchObject({
      code: 'ai_invalid_draft',
      details: { reason: 'not_json' },
    });
    fake({ answer: { text: JSON.stringify({ description: 'Linen.' }) } });
    await expect(draft(['title', 'seo', 'description'])).rejects.toMatchObject({
      code: 'ai_invalid_draft',
      details: { reason: 'missing_fields', missing: ['title', 'seo'] },
    });
  });

  it('parseDraft: strict JSON only, unrequested keys dropped, empty bullets allowed, limits', () => {
    const ok = (o: unknown, f: Parameters<typeof parseDraft>[1]) =>
      parseDraft({ text: JSON.stringify(o), stopReason: 'end_turn' }, f);
    expect(ok({ title: 'T', description: 'D' }, ['title'])).toEqual({ title: 'T' });
    expect(ok({ bullets: [] }, ['bullets'])).toEqual({ bullets: [] }); // thin facts: [] is a valid answer
    expect(ok({ bullets: ['a', 'b', 'c', 'd', 'e', 'f'] }, ['bullets']).bullets).toHaveLength(5);
    expect(ok({ title: 'x'.repeat(250) }, ['title']).title).toHaveLength(200);
    expect(() => ok({ bullets: 'one' }, ['bullets'])).toThrow(AppError);
    expect(() => ok({ seo: { title: 'x' } }, ['seo'])).toThrow(AppError);
    expect(() => ok([], ['title'])).toThrow(AppError);
    expect(() =>
      parseDraft({ text: '```json\n{"title":"T"}\n```', stopReason: 'end_turn' }, ['title']),
    ).toThrow(AppError); // the template forbids fences: a fenced answer is not strict JSON
  });
});

describe('the gateway’s outcomes become typed results the admin can explain (#664)', () => {
  it('AI off → 503 ai_disabled; nothing reaches the transport', async () => {
    const { transport } = fake({ env: { AI_ENABLED: '0' } });
    await expect(draft(['description'])).rejects.toMatchObject({
      code: 'ai_disabled',
      status: 503,
    });
    expect(transport.calls).toHaveLength(0);
  });

  it('over the monthly budget → 429 ai_budget_exceeded with the reset instant', async () => {
    fake({ limits: { monthlyTokens: 10, perMinute: 100 } });
    const err = (await draft(['description']).catch((e: unknown) => e)) as AppError;
    expect(err).toMatchObject({ code: 'ai_budget_exceeded', status: 429 });
    expect(err.details).toMatchObject({ limit_tokens: 10 });
    expect(String(err.details!.resets_at)).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/);
  });

  it('over the per-minute limit → 429 ai_rate_limited with Retry-After', async () => {
    fake({ limits: { monthlyTokens: 1_000_000, perMinute: 1 } });
    await draft(['description']);
    const err = (await draft(['description']).catch((e: unknown) => e)) as AppError;
    expect(err).toMatchObject({
      code: 'ai_rate_limited',
      status: 429,
      details: { limit_per_minute: 1 },
      headers: { 'Retry-After': '60' },
    });
  });

  it('a refusal → 422 ai_refused with its category; a provider failure → 502 ai_unavailable with the class only', async () => {
    fake({ answer: { stopReason: 'refusal', refusalCategory: 'policy', text: '' } });
    await expect(draft(['description'])).rejects.toMatchObject({
      code: 'ai_refused',
      status: 422,
      details: { category: 'policy' },
    });
    const boom = new TypeError('socket hang up');
    fake({ answer: boom });
    const err = (await draft(['description']).catch((e: unknown) => e)) as AppError;
    expect(err).toMatchObject({
      code: 'ai_unavailable',
      status: 502,
      details: { error_class: 'TypeError' },
    });
    expect(JSON.stringify(err.toBody())).not.toContain('socket hang up');
  });

  it('the real audit sink writes one ai_call_audit row per call, with no content', async () => {
    fake({ audit: createPgAuditSink(db.app) });
    await draft(['description']);
    const rows = await owner.query<{ store_id: string; template_id: string; outcome: string }>(
      `SELECT * FROM ai_call_audit WHERE store_id = $1`,
      [A],
    );
    expect(rows.rows).toHaveLength(1);
    expect(JSON.stringify(rows.rows[0])).not.toContain('linen');
  });
});

describe('toAppError: the branches no gateway call reaches in the tests above (#672 review)', () => {
  it('a limiter or audit failure is 503 unavailable; a config, template or denied-field error is 500 internal', () => {
    for (const err of [new AiLimiterError('RedisError'), new AiAuditError('audit write failed')]) {
      expect(toAppError(err)).toMatchObject({ code: 'unavailable', status: 503 });
    }
    for (const err of [
      new AiConfigError('no key'),
      new TemplateError('unknown template'),
      new DeniedFieldError(['email']),
    ]) {
      const mapped = toAppError(err) as AppError;
      expect(mapped).toMatchObject({ code: 'internal', status: 500 });
      expect(JSON.stringify(mapped.toBody())).not.toContain('email'); // never the gateway's message
    }
    const other = new Error('not the gateway');
    expect(toAppError(other)).toBe(other); // anything else is left for the error handler
  });

  it('a factory that throws while building the gateway is mapped too', async () => {
    setCopyDraftGatewayFactory(() => {
      throw new AiLimiterError('ECONNREFUSED');
    });
    await expect(draft(['description'])).rejects.toMatchObject({
      code: 'unavailable',
      status: 503,
    });
  });
});
