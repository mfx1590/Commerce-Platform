import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrganizationClient, createTenantClient } from '../src/index.js';
import { createTestDatabase, type TestDatabase } from '../src/testing.js';

// 0205 ai_call_audit (CONTRACT CHANGE #605, D8): the guarantees the migration itself makes, before packages/ai
// writes through it — store isolation, organization scope sees all, append-only for platform_app, the CHECKs.
const ORG = '50000000-0000-4000-8000-000000000101';
const LE = '50000000-0000-4000-8000-000000000111';
const STORE_A = '50000000-0000-4000-8000-000000000131';
const STORE_B = '50000000-0000-4000-8000-000000000132';

// Computed at run time: no 64-hex literal in the repository.
const HASH = createHash('sha256').update('ai-call-audit fixture').digest('hex');

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase('platform_ai_call_audit_test');
  const hq = createOrganizationClient(db.owner, { organizationId: ORG });
  await hq.transaction(async (tx) => {
    await tx.query(`INSERT INTO organization (id, slug, name) VALUES ($1, 'hq-ai', 'HQ')`, [ORG]);
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
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

const insert = `INSERT INTO ai_call_audit
  (organization_id, store_id, purpose, template_id, template_version, input_sha256, model, input_tokens, outcome)
  VALUES ($1, $2, 'drafting', 'product-copy-draft', 1, $3, 'claude-sonnet', $4, $5)`;

const storeA = () => createTenantClient(db.app, { organizationId: ORG, storeIds: [STORE_A] });
const storeB = () => createTenantClient(db.app, { organizationId: ORG, storeIds: [STORE_B] });
const count = `SELECT count(*)::int AS n FROM ai_call_audit`;

describe('ai_call_audit (0205, #605)', () => {
  it('a store-scoped client inserts and reads its own row', async () => {
    await storeA().transaction((tx) => tx.query(insert, [ORG, STORE_A, HASH, 120, 'ok']));
    const seen = await storeA().transaction((tx) =>
      tx.query(`SELECT store_id, outcome, input_tokens FROM ai_call_audit`),
    );
    expect(seen.rows).toEqual([{ store_id: STORE_A, outcome: 'ok', input_tokens: 120 }]);
  });

  it('another store sees none of it and cannot insert a row for the first store', async () => {
    const seen = await storeB().transaction((tx) => tx.query(count));
    expect(seen.rows[0].n).toBe(0);
    await expect(
      storeB().transaction((tx) => tx.query(insert, [ORG, STORE_A, HASH, 1, 'ok'])),
    ).rejects.toThrow(/row-level security/i);
  });

  it('organization scope sees every store', async () => {
    await storeB().transaction((tx) => tx.query(insert, [ORG, STORE_B, HASH, 0, 'over_budget']));
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    const seen = await hq.transaction((tx) => tx.query(count));
    expect(seen.rows[0].n).toBe(2);
  });

  it('is append-only for platform_app: UPDATE and DELETE are refused', async () => {
    await expect(
      storeA().transaction((tx) => tx.query(`UPDATE ai_call_audit SET input_tokens = 9`)),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      storeA().transaction((tx) => tx.query(`DELETE FROM ai_call_audit`)),
    ).rejects.toThrow(/permission denied/i);
  });

  it('the CHECKs reject a bad outcome, a bad input_sha256 and a negative token count', async () => {
    for (const params of [
      [ORG, STORE_A, HASH, 1, 'succeeded'], // not an outcome
      [ORG, STORE_A, HASH.toUpperCase(), 1, 'ok'], // not lower-case hex
      [ORG, STORE_A, 'z'.repeat(64), 1, 'ok'], // not hex
      [ORG, STORE_A, HASH, -1, 'ok'], // negative tokens
    ]) {
      await expect(storeA().transaction((tx) => tx.query(insert, params))).rejects.toThrow(
        /check constraint/i,
      );
    }
    // A hash of the wrong length is refused by char(64) or the CHECK, never stored.
    await expect(
      storeA().transaction((tx) => tx.query(insert, [ORG, STORE_A, HASH.slice(0, 63), 1, 'ok'])),
    ).rejects.toThrow(/check constraint/i);
  });
});
