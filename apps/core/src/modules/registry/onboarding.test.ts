// Store onboarding (#413): one transaction, idempotent by code, activation readiness.
import { createHash } from 'node:crypto';
import { createOrganizationClient } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../lib/errors';
import {
  activateStore,
  createStore,
  inMemoryStoreRegistrar,
  onboardStore,
  updateStore,
  type StoreOnboardingInput,
} from './index';

const ORG = '20000000-0000-4000-8000-000000000001';
const LE = '20000000-0000-4000-8000-000000000011';
const STAFF = '20000000-0000-4000-8000-000000000041';
const actor = { id: STAFF, type: 'staff' as const, requestId: 'req-onboard' };
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

let db: TestDatabase;
let hq: ReturnType<typeof createOrganizationClient>;

beforeAll(async () => {
  db = await createTestDatabase('core_onboarding');
  const owner = createOrganizationClient(db.owner, { organizationId: ORG });
  await owner.transaction(async (tx) => {
    await tx.query(`INSERT INTO organization (id, slug, name) VALUES ($1, 'hq', 'HQ')`, [ORG]);
    await tx.query(
      `INSERT INTO legal_entity (id, organization_id, code, name, country, currency) VALUES ($1, $2, 'le-a', 'A BV', 'NL', 'EUR')`,
      [LE, ORG],
    );
    await tx.query(
      `INSERT INTO staff_user (id, organization_id, keycloak_subject, email, display_name) VALUES ($1, $2, 'sub', 'a@example.com', 'A')`,
      [STAFF, ORG],
    );
    // The forced failure for the rollback test: the audit row of an onboarding of `brand-fail` is refused —
    // the LAST write before the outbox row, so every other row of the workflow has been written by then.
    await tx.query(`
      CREATE FUNCTION refuse_brand_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'store.onboard' AND NEW.after->'store'->>'code' = 'brand-fail' THEN
          RAISE EXCEPTION 'forced failure after the key was created';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER refuse_brand_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION refuse_brand_fail();
    `);
  });
  hq = createOrganizationClient(db.app, { organizationId: ORG, actorId: STAFF });
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

const brandC: StoreOnboardingInput = {
  legal_entity: { code: 'brand-c-bv', name: 'Brand C B.V.', country: 'NL', currency: 'EUR' },
  code: 'brand-c',
  name: 'Brand C',
  default_currency: 'EUR',
  default_locale: 'en-GB',
  default_country: 'NL',
  timezone: 'Europe/Amsterdam',
  currencies: ['GBP', 'EUR'],
  locales: ['nl-NL'],
  domain: { hostname: 'Brand-C.localhost' },
  settings: { payment: { invoice_allowed: false }, marketing: { anything: 1 } },
};

const count = async (sql: string, params: unknown[] = []) =>
  Number(
    (await db.owner.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, params)).rows[0]!
      .n,
  );

describe('onboardStore (#413)', () => {
  it('creates everything in one go, with the conventions, the audit row and store.created', async () => {
    const registrar = inMemoryStoreRegistrar();
    const { created, result } = await onboardStore(hq, brandC, registrar, actor);
    expect(created).toBe(true);
    const { store, legal_entity, domain, sales_channel, publishable_key } = result;

    expect(store).toMatchObject({
      code: 'brand-c',
      name: 'Brand C',
      status: 'draft',
      legal_entity_id: legal_entity.id,
      timezone: 'Europe/Amsterdam',
      content_space_id: 'brand-c',
      search_index: 'brand-c_products',
      currencies: ['EUR', 'GBP'], // the default first
      locales: ['en-GB', 'nl-NL'],
      settings: { payment: { invoice_allowed: false }, marketing: { anything: 1 } }, // unknown keys preserved
    });
    expect(legal_entity).toMatchObject({
      code: 'brand-c-bv',
      country: 'NL',
      currency: 'EUR',
      vat_number: null,
    });
    expect(domain).toMatchObject({
      hostname: 'brand-c.localhost',
      is_primary: true,
      verified_at: null,
    });
    expect(sales_channel).toMatchObject({
      code: 'web',
      name: 'Brand C',
      type: 'web',
      is_active: true,
    });
    expect(publishable_key).toMatchObject({
      name: 'storefront',
      type: 'publishable',
      sales_channel_id: sales_channel.id,
      revoked_at: null,
    });
    expect(publishable_key!.key).toMatch(/^pk_brand-c_[0-9a-f]{40}$/);
    expect(publishable_key!.key_prefix).toBe(publishable_key!.key.slice(0, 8));

    // stored hashed, never plain
    const keyRow = await db.owner.query<{ key_hash: string }>(
      'SELECT key_hash FROM store_api_key WHERE id = $1',
      [publishable_key!.id],
    );
    expect(keyRow.rows[0]!.key_hash).toBe(sha256(publishable_key!.key));

    const audit = await db.owner.query<{ action: string; after: Record<string, unknown> }>(
      'SELECT action, after FROM audit_log WHERE entity_id = $1',
      [store.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['store.onboard']);
    expect(JSON.stringify(audit.rows[0]!.after)).not.toContain(publishable_key!.key);
    expect(JSON.stringify(audit.rows[0]!.after)).not.toContain(keyRow.rows[0]!.key_hash);

    const events = await db.owner.query<{
      topic: string;
      payload: { code: string; status: string };
    }>('SELECT topic, payload FROM outbox WHERE aggregate_id = $1 ORDER BY seq', [store.id]);
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({
      topic: 'store.created',
      payload: { code: 'brand-c', status: 'draft' },
    });

    // registered AFTER the transaction, through the seam
    expect(registrar.registered.has(store.id)).toBe(true);
  });

  it('is idempotent: the same input again answers the same store, no key, nothing written, registration repeated', async () => {
    const registrar = inMemoryStoreRegistrar();
    const first = await onboardStore(hq, brandC, registrar, actor);
    const audits = await count('audit_log');
    const events = await count('outbox');
    const les = await count('legal_entity');

    const again = await onboardStore(
      hq,
      { ...brandC, domain: { hostname: 'BRAND-C.localhost' } },
      registrar,
      actor,
    );
    expect(again.created).toBe(false);
    expect(again.result.store.id).toBe(first.result.store.id);
    expect(again.result.publishable_key).toBeNull();
    expect(again.result).toMatchObject({
      legal_entity: { code: 'brand-c-bv' },
      domain: { hostname: 'brand-c.localhost', is_primary: true },
      sales_channel: { code: 'web' },
    });
    expect(await count('audit_log')).toBe(audits);
    expect(await count('outbox')).toBe(events);
    expect(await count('legal_entity')).toBe(les);
    expect(registrar.ensureCalls).toEqual([first.result.store.id, first.result.store.id]); // the repeat registers again (repair path)
  });

  it('the same code with a different definition is a 409 naming what differs', async () => {
    const registrar = inMemoryStoreRegistrar();
    await expect(
      onboardStore(
        hq,
        { ...brandC, name: 'Brand C!', currencies: ['EUR', 'USD'] },
        registrar,
        actor,
      ),
    ).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
      details: { field: 'code', differs: ['currencies', 'name'] },
    });
    await expect(
      onboardStore(
        hq,
        { ...brandC, legal_entity_id: LE, legal_entity: undefined },
        registrar,
        actor,
      ),
    ).rejects.toMatchObject({ code: 'conflict', details: { differs: ['legal_entity'] } });
    expect(registrar.ensureCalls).toEqual([]);
  });

  it('uses an existing legal entity by id; an unknown id, or neither/both forms, is a 400', async () => {
    const registrar = inMemoryStoreRegistrar();
    const { result } = await onboardStore(
      hq,
      {
        ...brandC,
        legal_entity: undefined,
        legal_entity_id: LE,
        code: 'brand-d',
        domain: { hostname: 'brand-d.localhost' },
      },
      registrar,
      actor,
    );
    expect(result.store.legal_entity_id).toBe(LE);
    expect(result.legal_entity.code).toBe('le-a');

    const unknown = '20000000-0000-4000-8000-0000000000ff';
    await expect(
      onboardStore(
        hq,
        {
          ...brandC,
          legal_entity: undefined,
          legal_entity_id: unknown,
          code: 'brand-e',
          domain: { hostname: 'e.localhost' },
        },
        registrar,
        actor,
      ),
    ).rejects.toMatchObject({
      code: 'validation_error',
      status: 400,
      details: { legal_entity_id: 'unknown' },
    });
    await expect(
      onboardStore(
        hq,
        {
          ...brandC,
          legal_entity: undefined,
          code: 'brand-e',
          domain: { hostname: 'e.localhost' },
        },
        registrar,
        actor,
      ),
    ).rejects.toMatchObject({
      code: 'validation_error',
      details: { legal_entity: 'exactly one of legal_entity_id and legal_entity' },
    });
    await expect(
      onboardStore(
        hq,
        { ...brandC, legal_entity_id: LE, code: 'brand-e', domain: { hostname: 'e.localhost' } },
        registrar,
        actor,
      ),
    ).rejects.toMatchObject({
      code: 'validation_error',
      details: { legal_entity: 'exactly one of legal_entity_id and legal_entity' },
    });
  });

  it('a hostname another store already has is a 409; invalid input is a 400 before anything is written', async () => {
    const registrar = inMemoryStoreRegistrar();
    const stores = await count('store');
    await expect(
      onboardStore(
        hq,
        {
          ...brandC,
          code: 'brand-f',
          legal_entity: { ...brandC.legal_entity!, code: 'brand-f-bv' },
        },
        registrar,
        actor,
      ),
    ).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
      details: { field: 'domain.hostname' },
    });
    await expect(
      onboardStore(
        hq,
        { ...brandC, code: 'Brand_F', domain: { hostname: 'not a host' } },
        registrar,
        actor,
      ),
    ).rejects.toMatchObject({
      code: 'validation_error',
      details: { code: 'lowercase kebab-case', 'domain.hostname': 'lowercase hostname' },
    });
    expect(await count('store')).toBe(stores);
    expect(await count(`legal_entity WHERE code = 'brand-f-bv'`)).toBe(0);
  });

  it('settings of the wrong shape are a 422 (after the 400s), nothing written', async () => {
    const registrar = inMemoryStoreRegistrar();
    let caught: unknown;
    try {
      await onboardStore(
        hq,
        {
          ...brandC,
          code: 'brand-g',
          domain: { hostname: 'g.localhost' },
          legal_entity: { ...brandC.legal_entity!, code: 'brand-g-bv' },
          settings: { payment: { invoice_allowed: 'yes' } },
        },
        registrar,
        actor,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect(caught).toMatchObject({
      code: 'validation_error',
      status: 422,
      details: { settings: { 'payment.invoice_allowed': 'boolean' } },
    });
    expect(await count(`store WHERE code = 'brand-g'`)).toBe(0);
  });

  it('a failure after the key was created leaves no row of any kind (one transaction)', async () => {
    const registrar = inMemoryStoreRegistrar();
    const before = {
      stores: await count('store'),
      les: await count('legal_entity'),
      domains: await count('store_domain'),
      channels: await count('sales_channel'),
      keys: await count('store_api_key'),
      locales: await count('store_locale'),
      currencies: await count('store_currency'),
      audits: await count('audit_log'),
      events: await count('outbox'),
    };
    await expect(
      onboardStore(
        hq,
        {
          ...brandC,
          code: 'brand-fail',
          domain: { hostname: 'fail.localhost' },
          legal_entity: { ...brandC.legal_entity!, code: 'brand-fail-bv' },
        },
        registrar,
        actor,
      ),
    ).rejects.toThrow(/forced failure/);
    expect({
      stores: await count('store'),
      les: await count('legal_entity'),
      domains: await count('store_domain'),
      channels: await count('sales_channel'),
      keys: await count('store_api_key'),
      locales: await count('store_locale'),
      currencies: await count('store_currency'),
      audits: await count('audit_log'),
      events: await count('outbox'),
    }).toEqual(before);
    expect(registrar.ensureCalls).toEqual([]);
  });
});

describe('activateStore and the readiness gate (#413)', () => {
  it('an onboarded, registered store becomes active once; again is a no-op', async () => {
    const registrar = inMemoryStoreRegistrar();
    const { result } = await onboardStore(
      hq,
      {
        ...brandC,
        code: 'brand-h',
        domain: { hostname: 'h.localhost' },
        legal_entity: { ...brandC.legal_entity!, code: 'brand-h-bv' },
      },
      registrar,
      actor,
    );
    const active = await activateStore(hq, result.store.id, registrar, actor);
    expect(active.status).toBe('active');
    const again = await activateStore(hq, result.store.id, registrar, actor);
    expect(again.status).toBe('active');

    const events = await db.owner.query<{ topic: string; payload: { changed_fields: string[] } }>(
      'SELECT topic, payload FROM outbox WHERE aggregate_id = $1 ORDER BY seq',
      [result.store.id],
    );
    expect(events.rows.map((r) => r.topic)).toEqual(['store.created', 'store.updated']);
    expect(events.rows[1]!.payload.changed_fields).toEqual(['status']);
    const audit = await db.owner.query<{ action: string }>(
      'SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY created_at',
      [result.store.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['store.onboard', 'store.activate']);
  });

  it('an incomplete store is refused with exactly the missing prerequisites, in order', async () => {
    const registrar = inMemoryStoreRegistrar();
    const bare = await createStore(
      hq,
      {
        legal_entity_id: LE,
        code: 'brand-i',
        name: 'Brand I',
        default_currency: 'EUR',
        default_locale: 'en-GB',
        default_country: 'NL',
      },
      actor,
    );
    await expect(activateStore(hq, bare.id, registrar, actor)).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
      details: { missing: ['primary_domain', 'publishable_key', 'fga_object'] },
    });
    // the same gate on updateStore; without a registrar the OpenFGA object counts as missing
    await expect(updateStore(hq, bare.id, { status: 'active' }, actor)).rejects.toMatchObject({
      details: { missing: ['primary_domain', 'publishable_key', 'fga_object'] },
    });
    expect((await updateStore(hq, bare.id, { name: 'Brand I!' }, actor)).name).toBe('Brand I!'); // other patches pass
  });

  it('an archived store cannot be activated; paused can', async () => {
    const registrar = inMemoryStoreRegistrar();
    const { result } = await onboardStore(
      hq,
      {
        ...brandC,
        code: 'brand-j',
        domain: { hostname: 'j.localhost' },
        legal_entity: { ...brandC.legal_entity!, code: 'brand-j-bv' },
      },
      registrar,
      actor,
    );
    await updateStore(hq, result.store.id, { status: 'paused' }, actor);
    expect((await activateStore(hq, result.store.id, registrar, actor)).status).toBe('active');
    await updateStore(hq, result.store.id, { status: 'archived' }, actor);
    await expect(activateStore(hq, result.store.id, registrar, actor)).rejects.toMatchObject({
      code: 'conflict',
      details: { status: 'archived' },
    });
    await expect(
      updateStore(hq, result.store.id, { status: 'active' }, actor, { registrar }),
    ).rejects.toMatchObject({
      details: { status: 'archived' },
    });
  });

  it('updateStore refuses wrong-shape settings with 422 and keeps unknown keys', async () => {
    const registrar = inMemoryStoreRegistrar();
    const { result } = await onboardStore(
      hq,
      {
        ...brandC,
        code: 'brand-k',
        domain: { hostname: 'k.localhost' },
        legal_entity: { ...brandC.legal_entity!, code: 'brand-k-bv' },
      },
      registrar,
      actor,
    );
    await expect(
      updateStore(hq, result.store.id, { settings: { tax: { provider: 'odoo' } } }, actor),
    ).rejects.toMatchObject({
      code: 'validation_error',
      status: 422,
      details: { settings: { 'tax.provider': 'one of table, stripe' } },
    });
    const ok = await updateStore(
      hq,
      result.store.id,
      { settings: { tax: { provider: 'stripe' }, custom: { x: 1 } } },
      actor,
    );
    expect(ok.settings).toEqual({ tax: { provider: 'stripe' }, custom: { x: 1 } });
  });

  // The live half (#415 / #421): test/auth-live.test.ts "#413 onboarding (live)" — the onboarded store is visible to
  // the seeded owner through OpenFGA scope resolution and refused to a store admin.
});
