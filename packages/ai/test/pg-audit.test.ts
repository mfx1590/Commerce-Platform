// The Postgres audit sink against a throwaway database migrated with packages/db (0205 ai_call_audit): the gateway's
// records fit the table's CHECKs for every outcome, rows land in store scope under RLS, and no column holds content.
import { createOrganizationClient, createTenantClient } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAiGateway,
  createFakeTransport,
  createMemoryLimiter,
  createPgAuditSink,
  type AiGatewayOptions,
} from '../src/index.js';

const ORG = '51000000-0000-4000-8000-000000000101';
const LE = '51000000-0000-4000-8000-000000000111';
const STORE_A = '51000000-0000-4000-8000-000000000131';
const STORE_B = '51000000-0000-4000-8000-000000000132';
const ACTOR = '51000000-0000-4000-8000-000000000177';

const copy = {
  brandVoice: 'zephyrine and calm',
  locale: 'nl-NL',
  productTitle: 'Quillwort linen shirt',
  attributes: ['marmalade-coloured linen', 'write to anna@example.org'],
  audience: 'grownups who like wandering',
};
const CONTENT_WORDS = ['zephyrine', 'Quillwort', 'marmalade', 'wandering', 'example.org'];

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase('platform_ai_audit_sink_test');
  const hq = createOrganizationClient(db.owner, { organizationId: ORG });
  await hq.transaction(async (tx) => {
    await tx.query(`INSERT INTO organization (id, slug, name) VALUES ($1, 'hq-ai-sink', 'HQ')`, [
      ORG,
    ]);
    await tx.query(
      `INSERT INTO legal_entity (id, organization_id, code, name, country, currency) VALUES ($1, $2, 'le', 'LE', 'NL', 'EUR')`,
      [LE, ORG],
    );
    for (const [id, code] of [
      [STORE_A, 'brand-a'],
      [STORE_B, 'brand-b'],
    ] as const) {
      await tx.query(
        `INSERT INTO store (id, organization_id, legal_entity_id, code, name, default_currency, default_locale, default_country)
         VALUES ($1, $2, $3, $4, $4, 'EUR', 'en-GB', 'NL')`,
        [id, ORG, LE, code],
      );
    }
  });
});

afterAll(async () => {
  await db?.drop();
});

function gateway(over: Partial<AiGatewayOptions> = {}) {
  return createAiGateway({
    organizationId: ORG,
    storeId: STORE_A,
    purpose: 'drafting',
    actorId: ACTOR,
    transport: createFakeTransport(),
    limiter: createMemoryLimiter(),
    audit: createPgAuditSink(db.app),
    env: { AI_ENABLED: '1' },
    ...over,
  });
}

const rowsOf = (storeIds: string[]) =>
  createTenantClient(db.app, { organizationId: ORG, storeIds }).transaction((tx) =>
    tx.query(`SELECT * FROM ai_call_audit ORDER BY created_at, id`),
  );

describe('createPgAuditSink (ai_call_audit, 0205)', () => {
  it('writes one row per outcome, every one inside the CHECKs, and never content', async () => {
    const draft = await gateway().complete('product-copy-draft@1', copy);
    await gateway({ env: {} })
      .complete('product-copy-draft@1', copy)
      .catch(() => {});
    await gateway()
      .complete('product-copy-draft@1', { ...copy, customer: { email: 'x' } } as never)
      .catch(() => {});
    await gateway()
      .complete('Not A Key!' as never, {} as never)
      .catch(() => {});
    await gateway({ limits: { monthlyTokens: 10, perMinute: 5 } })
      .complete('product-copy-draft@1', copy)
      .catch(() => {});

    const { rows } = await rowsOf([STORE_A]);
    expect(rows.map((r) => r.outcome)).toEqual([
      'ok',
      'disabled',
      'denied_field',
      'error',
      'over_budget',
    ]);
    expect(rows[0]).toMatchObject({
      id: draft.auditId,
      organization_id: ORG,
      store_id: STORE_A,
      actor_id: ACTOR,
      purpose: 'drafting',
      template_id: 'product-copy-draft',
      template_version: 1,
      redactions: 1,
      model: 'claude-sonnet-5-5',
      served_model: 'claude-sonnet-5-5',
      input_tokens: draft.usage.inputTokens,
      output_tokens: draft.usage.outputTokens,
      error_class: null,
    });
    expect(Number(rows[0]!.cost_estimate_micro_usd)).toBe(draft.costMicroUsd);
    expect(rows[3]).toMatchObject({ template_id: 'unknown', error_class: 'TemplateError' });
    const serialised = JSON.stringify(rows);
    for (const w of CONTENT_WORDS) expect(serialised, w).not.toContain(w);
    expect(serialised).not.toContain(draft.text);
  });

  it('store scope: another store sees none of them; the app role cannot change or delete a row', async () => {
    expect((await rowsOf([STORE_B])).rows).toEqual([]);
    const a = createTenantClient(db.app, { organizationId: ORG, storeIds: [STORE_A] });
    await expect(a.query(`UPDATE ai_call_audit SET outcome = 'ok'`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(a.query(`DELETE FROM ai_call_audit`)).rejects.toThrow(/permission denied/);
  });

  it('a failed write withholds the draft (AiAuditError) and nothing is returned', async () => {
    const other = '51000000-0000-4000-8000-000000000999'; // a store that does not exist: the FK refuses
    await expect(
      gateway({ storeId: other }).complete('product-copy-draft@1', copy),
    ).rejects.toMatchObject({ name: 'AiAuditError' });
  });
});
