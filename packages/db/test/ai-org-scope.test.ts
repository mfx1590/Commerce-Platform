import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrganizationClient, createTenantClient } from '../src/index.js';
import { createTestDatabase, type TestDatabase } from '../src/testing.js';

// 0206 (#606, CONTRACT CHANGE #668 / REQUEST #669): organization-scope ai_call_audit rows (store_id NULL), the
// per-step columns, and ai_qa_feedback. RLS kind `store_nullable` on both: a store row for a session that can access
// the store, a NULL-store row for organization scope ONLY; another organization sees nothing; append-only.
const ORG = '50000000-0000-4000-8000-000000000201';
const ORG_2 = '50000000-0000-4000-8000-000000000202';
const LE = '50000000-0000-4000-8000-000000000211';
const LE_2 = '50000000-0000-4000-8000-000000000212';
const STORE_A = '50000000-0000-4000-8000-000000000231';
const STORE_B = '50000000-0000-4000-8000-000000000232';
const STORE_Z = '50000000-0000-4000-8000-000000000239'; // ORG_2's store
const ACTOR = '50000000-0000-4000-8000-000000000251';
const CONV_A = '50000000-0000-4000-8000-000000000261';
const CONV_B = '50000000-0000-4000-8000-000000000262';
const CONV_HQ = '50000000-0000-4000-8000-000000000263';

// Computed at run time: no 64-hex literal in the repository.
const HASH = createHash('sha256').update('ai-org-scope fixture').digest('hex');

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase('platform_ai_org_scope_test');
  for (const [org, le, slug, stores] of [
    [ORG, LE, 'hq-ai-org', [STORE_A, STORE_B]],
    [ORG_2, LE_2, 'other-ai-org', [STORE_Z]],
  ] as const) {
    const hq = createOrganizationClient(db.owner, { organizationId: org });
    await hq.transaction(async (tx) => {
      await tx.query(`INSERT INTO organization (id, slug, name) VALUES ($1, $2, 'HQ')`, [
        org,
        slug,
      ]);
      await tx.query(
        `INSERT INTO legal_entity (id, organization_id, code, name, country, currency) VALUES ($1, $2, 'le', 'LE', 'NL', 'EUR')`,
        [le, org],
      );
      for (const id of stores) {
        await tx.query(
          `INSERT INTO store (id, organization_id, legal_entity_id, code, name, default_currency, default_locale, default_country)
           VALUES ($1, $2, $3, $4, $4, 'EUR', 'en-GB', 'NL')`,
          [id, org, le, `s-${id.slice(-3)}`],
        );
      }
    });
  }
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

const storeA = () => createTenantClient(db.app, { organizationId: ORG, storeIds: [STORE_A] });
const storeB = () => createTenantClient(db.app, { organizationId: ORG, storeIds: [STORE_B] });
const hq = () => createOrganizationClient(db.app, { organizationId: ORG });
const otherOrg = () => createOrganizationClient(db.app, { organizationId: ORG_2 });
const otherOrgStore = () =>
  createTenantClient(db.app, { organizationId: ORG_2, storeIds: [STORE_Z] });

// 0205's columns plus 0206's per-step columns.
const auditInsert = `INSERT INTO ai_call_audit
  (organization_id, store_id, purpose, template_id, template_version, input_sha256, model, outcome,
   conversation_id, step, tool_names)
  VALUES ($1, $2, $3, 'bi-qa-answer', 1, $4, 'claude-sonnet', $5, $6, $7, $8)`;
const audit = (
  store: string | null,
  conv: string | null,
  step: number | null,
  tools: string[] | null = [],
  outcome = 'ok',
  purpose = 'analysis',
) => [ORG, store, purpose, HASH, outcome, conv, step, tools];

const feedbackInsert = `INSERT INTO ai_qa_feedback (organization_id, store_id, conversation_id, actor_id, rating)
  VALUES ($1, $2, $3, $4, $5)`;

const auditSeen = `SELECT store_id, conversation_id, step, tool_names FROM ai_call_audit
  ORDER BY conversation_id, step`;
const feedbackSeen = `SELECT store_id, conversation_id, rating FROM ai_qa_feedback
  ORDER BY conversation_id, created_at`;

describe('ai_call_audit organization scope and steps (0206, #606)', () => {
  it("a store row keeps working with the 0205 columns only (NULL / NULL / '{}')", async () => {
    await storeA().transaction((tx) =>
      tx.query(
        `INSERT INTO ai_call_audit
          (organization_id, store_id, purpose, template_id, template_version, input_sha256, model, outcome)
          VALUES ($1, $2, 'drafting', 'product-copy-draft', 1, $3, 'claude-sonnet', 'ok')`,
        [ORG, STORE_A, HASH],
      ),
    );
    const seen = await storeA().transaction((tx) =>
      tx.query(`SELECT store_id, conversation_id, step, tool_names FROM ai_call_audit`),
    );
    expect(seen.rows).toEqual([
      { store_id: STORE_A, conversation_id: null, step: null, tool_names: [] },
    ]);
  });

  it('a store-scoped client writes the steps of a store run; another store sees none of them', async () => {
    await storeA().transaction(async (tx) => {
      await tx.query(auditInsert, audit(STORE_A, CONV_A, 0, ['query_metrics']));
      await tx.query(auditInsert, audit(STORE_A, CONV_A, 1, []));
    });
    await storeB().transaction((tx) =>
      tx.query(auditInsert, audit(STORE_B, CONV_B, 0, ['query_metrics'])),
    );
    const b = await storeB().transaction((tx) => tx.query(auditSeen));
    expect(b.rows).toEqual([
      { store_id: STORE_B, conversation_id: CONV_B, step: 0, tool_names: ['query_metrics'] },
    ]);
    // Store B cannot write a row for store A, nor an organization-scope row.
    await expect(
      storeB().transaction((tx) => tx.query(auditInsert, audit(STORE_A, CONV_B, 1))),
    ).rejects.toThrow(/row-level security/i);
    await expect(
      storeB().transaction((tx) => tx.query(auditInsert, audit(null, CONV_B, 1))),
    ).rejects.toThrow(/row-level security/i);
  });

  it('organization scope inserts and reads a NULL-store run (purpose analysis, outcome tool_loop_cap)', async () => {
    await hq().transaction(async (tx) => {
      await tx.query(auditInsert, audit(null, CONV_HQ, 0, ['query_metrics', 'query_metrics']));
      await tx.query(auditInsert, audit(null, CONV_HQ, 1, ['query_metrics'], 'tool_loop_cap'));
    });
    const seen = await hq().transaction((tx) =>
      tx.query(
        `SELECT step, tool_names, outcome FROM ai_call_audit
         WHERE organization_id = $1 AND conversation_id = $2 ORDER BY step`,
        [ORG, CONV_HQ],
      ),
    );
    expect(seen.rows).toEqual([
      { step: 0, tool_names: ['query_metrics', 'query_metrics'], outcome: 'ok' },
      { step: 1, tool_names: ['query_metrics'], outcome: 'tool_loop_cap' },
    ]);
    // HQ sees every store row and its own rows: 1 (0205-shape) + 2 (A) + 1 (B) + 2 (HQ).
    const all = await hq().transaction((tx) =>
      tx.query(`SELECT count(*)::int AS n FROM ai_call_audit`),
    );
    expect(all.rows[0].n).toBe(6);
  });

  it('a store-scoped client never sees an organization-scope row, even of its own organization', async () => {
    const a = await storeA().transaction((tx) =>
      tx.query(`SELECT count(*)::int AS n FROM ai_call_audit WHERE store_id IS NULL`),
    );
    expect(a.rows[0].n).toBe(0);
    const aAll = await storeA().transaction((tx) =>
      tx.query(`SELECT count(*)::int AS n FROM ai_call_audit`),
    );
    expect(aAll.rows[0].n).toBe(3); // its own rows only
  });

  it('another organization sees nothing and cannot write a row for this one', async () => {
    for (const client of [otherOrg(), otherOrgStore()]) {
      const seen = await client.transaction((tx) =>
        tx.query(`SELECT count(*)::int AS n FROM ai_call_audit`),
      );
      expect(seen.rows[0].n).toBe(0);
    }
    await expect(
      otherOrg().transaction((tx) => tx.query(auditInsert, audit(null, randomUUID(), 0))),
    ).rejects.toThrow(/row-level security/i);
  });

  it('the CHECKs reject a negative step, a step without a conversation (and the reverse), an unknown purpose or outcome', async () => {
    for (const params of [
      audit(null, CONV_HQ, -1),
      audit(null, CONV_HQ, null), // a conversation row without its step
      audit(null, null, 0), // a step without a conversation
      audit(null, CONV_HQ, 2, [], 'ok', 'chat'),
      audit(null, CONV_HQ, 2, [], 'loop_cap'),
    ]) {
      await expect(hq().transaction((tx) => tx.query(auditInsert, params))).rejects.toThrow(
        /check constraint/i,
      );
    }
    // tool_names is NOT NULL ('{}' = no tool calls).
    await expect(
      hq().transaction((tx) => tx.query(auditInsert, audit(null, CONV_HQ, 2, null))),
    ).rejects.toThrow(/not-null constraint/i);
  });

  it('accepts every purpose (drafting, classification, analysis) and every outcome incl. tool_loop_cap', async () => {
    const conv = randomUUID();
    let step = 0;
    await hq().transaction(async (tx) => {
      for (const purpose of ['drafting', 'classification', 'analysis']) {
        await tx.query(auditInsert, audit(STORE_A, conv, step++, [], 'ok', purpose));
      }
      for (const outcome of [
        'ok',
        'refused',
        'max_tokens',
        'error',
        'disabled',
        'over_budget',
        'rate_limited',
        'denied_field',
        'tool_loop_cap',
      ]) {
        await tx.query(auditInsert, audit(null, conv, step++, [], outcome));
      }
    });
    const seen = await hq().transaction((tx) =>
      tx.query(`SELECT count(*)::int AS n FROM ai_call_audit WHERE conversation_id = $1`, [conv]),
    );
    expect(seen.rows[0].n).toBe(12);
  });

  it('stays append-only for platform_app, organization-scope rows included', async () => {
    for (const client of [hq(), storeA()]) {
      await expect(
        client.transaction((tx) => tx.query(`UPDATE ai_call_audit SET step = 9`)),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        client.transaction((tx) => tx.query(`DELETE FROM ai_call_audit`)),
      ).rejects.toThrow(/permission denied/i);
    }
  });
});

describe('ai_qa_feedback (0206, #606)', () => {
  it('store rows are store-scoped: store A writes and reads its own, store B sees none of them', async () => {
    // Two transactions: created_at is the transaction's now(). The later rating replaces the earlier one.
    await storeA().transaction((tx) =>
      tx.query(feedbackInsert, [ORG, STORE_A, CONV_A, ACTOR, 'down']),
    );
    await storeA().transaction((tx) =>
      tx.query(feedbackInsert, [ORG, STORE_A, CONV_A, ACTOR, 'up']),
    );
    const latest = await storeA().transaction((tx) =>
      tx.query(
        `SELECT rating FROM ai_qa_feedback
         WHERE organization_id = $1 AND conversation_id = $2 AND actor_id = $3
         ORDER BY created_at DESC LIMIT 1`,
        [ORG, CONV_A, ACTOR],
      ),
    );
    expect(latest.rows).toEqual([{ rating: 'up' }]);
    const b = await storeB().transaction((tx) => tx.query(feedbackSeen));
    expect(b.rows).toEqual([]);
    await expect(
      storeB().transaction((tx) => tx.query(feedbackInsert, [ORG, STORE_A, CONV_A, ACTOR, 'down'])),
    ).rejects.toThrow(/row-level security/i);
  });

  it('a NULL-store row is written and read by organization scope only', async () => {
    await hq().transaction((tx) => tx.query(feedbackInsert, [ORG, null, CONV_HQ, ACTOR, 'up']));
    const seen = await hq().transaction((tx) =>
      tx.query(`SELECT store_id, rating FROM ai_qa_feedback WHERE conversation_id = $1`, [CONV_HQ]),
    );
    expect(seen.rows).toEqual([{ store_id: null, rating: 'up' }]);
    // HQ sees the store rows too.
    const all = await hq().transaction((tx) =>
      tx.query(`SELECT count(*)::int AS n FROM ai_qa_feedback`),
    );
    expect(all.rows[0].n).toBe(3);
    // A store-scoped client neither sees nor writes an organization row.
    const a = await storeA().transaction((tx) =>
      tx.query(`SELECT count(*)::int AS n FROM ai_qa_feedback WHERE store_id IS NULL`),
    );
    expect(a.rows[0].n).toBe(0);
    await expect(
      storeA().transaction((tx) => tx.query(feedbackInsert, [ORG, null, CONV_HQ, ACTOR, 'down'])),
    ).rejects.toThrow(/row-level security/i);
  });

  it('another organization sees nothing and cannot write a row for this one', async () => {
    for (const client of [otherOrg(), otherOrgStore()]) {
      const seen = await client.transaction((tx) => tx.query(feedbackSeen));
      expect(seen.rows).toEqual([]);
    }
    await expect(
      otherOrg().transaction((tx) => tx.query(feedbackInsert, [ORG, null, CONV_HQ, ACTOR, 'up'])),
    ).rejects.toThrow(/row-level security/i);
  });

  it('the rating CHECK accepts up and down only', async () => {
    for (const rating of ['meh', 'UP', '']) {
      await expect(
        hq().transaction((tx) => tx.query(feedbackInsert, [ORG, null, CONV_HQ, ACTOR, rating])),
      ).rejects.toThrow(/check constraint/i);
    }
  });

  it('is append-only for platform_app: UPDATE and DELETE are refused', async () => {
    for (const client of [hq(), storeA()]) {
      await expect(
        client.transaction((tx) => tx.query(`UPDATE ai_qa_feedback SET rating = 'down'`)),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        client.transaction((tx) => tx.query(`DELETE FROM ai_qa_feedback`)),
      ).rejects.toThrow(/permission denied/i);
    }
  });
});
