import { createHash } from 'node:crypto';
import { createOrganizationClient, createTenantClient } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../lib/errors';
import { withEvents } from '../../outbox';
import {
  addCurrency,
  addDomain,
  addLocale,
  createApiKey,
  createSalesChannel,
  createStore,
  getStore,
  listApiKeys,
  listStores,
  revokeApiKey,
  updateStore,
} from './index';

const ORG = '20000000-0000-4000-8000-000000000001';
const LE = '20000000-0000-4000-8000-000000000011';
const STAFF = '20000000-0000-4000-8000-000000000041';
const actor = { id: STAFF, type: 'staff' as const, requestId: 'req-1' };

let db: TestDatabase;
let hq: ReturnType<typeof createOrganizationClient>;

beforeAll(async () => {
  db = await createTestDatabase('core_registry');
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
  });
  // Everything below runs as platform_app (RLS enforced), the way the application does.
  hq = createOrganizationClient(db.app, { organizationId: ORG, actorId: STAFF });
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

const brandA = {
  legal_entity_id: LE,
  code: 'brand-a',
  name: 'Brand A',
  default_currency: 'EUR',
  default_locale: 'en-GB',
  default_country: 'NL',
  timezone: 'Europe/Amsterdam',
  locales: ['de-DE'],
  currencies: ['EUR', 'GBP'],
};

describe('registry: stores', () => {
  it('creates a store with default locale/currency rows, audit_log and store.created in one transaction', async () => {
    const store = await createStore(hq, brandA, actor);
    expect(store).toMatchObject({
      code: 'brand-a',
      name: 'Brand A',
      status: 'draft',
      default_currency: 'EUR',
      psp_account_id: null,
      theme: {},
    });
    expect(store.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const locales = await hq.query<{ locale: string; is_default: boolean }>(
      'SELECT locale, is_default FROM store_locale WHERE store_id = $1 ORDER BY locale',
      [store.id],
    );
    expect(locales.rows).toEqual([
      { locale: 'de-DE', is_default: false },
      { locale: 'en-GB', is_default: true },
    ]);
    const currencies = await hq.query<{ currency: string; is_default: boolean }>(
      'SELECT currency, is_default FROM store_currency WHERE store_id = $1 ORDER BY currency',
      [store.id],
    );
    expect(currencies.rows).toEqual([
      { currency: 'EUR', is_default: true },
      { currency: 'GBP', is_default: false },
    ]);

    const audit = await hq.query(
      `SELECT actor_id, actor_type, action, entity_type, request_id, after->>'code' AS code
       FROM audit_log WHERE entity_id = $1`,
      [store.id],
    );
    expect(audit.rows).toEqual([
      {
        actor_id: STAFF,
        actor_type: 'staff',
        action: 'store.create',
        entity_type: 'store',
        request_id: 'req-1',
        code: 'brand-a',
      },
    ]);

    const outbox = await hq.query(
      `SELECT topic, version, store_id, aggregate_type, aggregate_id, published_at, payload, headers
       FROM outbox WHERE aggregate_id = $1 ORDER BY seq`,
      [store.id],
    );
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0]).toMatchObject({
      topic: 'store.created',
      version: 1,
      store_id: store.id,
      aggregate_type: 'store',
      aggregate_id: store.id,
      published_at: null,
    });
    expect(outbox.rows[0]!.payload).toMatchObject({
      store_id: store.id,
      code: 'brand-a',
      status: 'draft',
      legal_entity_id: LE,
    });
    expect(outbox.rows[0]!.headers.actor).toEqual({ type: 'staff', id: STAFF });
  });

  it('rejects a duplicate code with 409 conflict and invalid input with 400', async () => {
    await expect(createStore(hq, brandA, actor)).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
    });
    await expect(
      createStore(hq, { ...brandA, code: 'Brand_A', default_currency: 'eur' }, actor),
    ).rejects.toMatchObject({
      code: 'validation_error',
      details: { code: 'lowercase kebab-case', default_currency: 'ISO-4217 upper-case' },
    });
  });

  it('updates a store and emits store.updated with the sorted changed fields; no event when nothing changed', async () => {
    const [store] = (await listStores(hq)).items;
    const updated = await updateStore(hq, store!.id, { name: 'Brand A!', status: 'active' }, actor);
    expect(updated).toMatchObject({ name: 'Brand A!', status: 'active' });

    const same = await updateStore(hq, store!.id, { name: 'Brand A!' }, actor);
    expect(same.name).toBe('Brand A!');

    const events = await hq.query<{ topic: string; payload: { changed_fields: string[] } }>(
      `SELECT topic, payload FROM outbox WHERE aggregate_id = $1 ORDER BY seq`,
      [store!.id],
    );
    expect(events.rows.map((r) => r.topic)).toEqual(['store.created', 'store.updated']);
    expect(events.rows[1]!.payload.changed_fields).toEqual(['name', 'status']);

    const audit = await hq.query(
      `SELECT action, before->>'name' AS before_name, after->>'name' AS after_name
       FROM audit_log WHERE entity_id = $1 AND action = 'store.update'`,
      [store!.id],
    );
    expect(audit.rows).toEqual([
      { action: 'store.update', before_name: 'Brand A', after_name: 'Brand A!' },
    ]);
  });

  it('a store-scoped client cannot create stores and cannot see other stores', async () => {
    const a = (await listStores(hq)).items[0]!;
    const b = await createStore(hq, { ...brandA, code: 'brand-b', name: 'Brand B' }, actor);
    const scopedA = createTenantClient(db.app, { organizationId: ORG, storeIds: [a.id] });

    await expect(createStore(scopedA, { ...brandA, code: 'brand-c' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(getStore(scopedA, b.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await listStores(scopedA)).items.map((s) => s.id)).toEqual([a.id]);
    expect((await listStores(hq)).total).toBe(2);
  });
});

describe('registry: domains, locales, currencies', () => {
  it('keeps exactly one primary domain per store', async () => {
    const store = (await listStores(hq)).items.find((s) => s.code === 'brand-a')!;
    const first = await addDomain(hq, store.id, { hostname: 'Shop.Brand-A.example' }, actor);
    expect(first).toMatchObject({
      hostname: 'shop.brand-a.example',
      is_primary: true,
      verified_at: null,
    });
    const second = await addDomain(hq, store.id, { hostname: 'www.brand-a.example' }, actor);
    expect(second.is_primary).toBe(false);
    const third = await addDomain(hq, store.id, { hostname: 'brand-a.example', is_primary: true });
    expect(third.is_primary).toBe(true);

    const primaries = await hq.query<{ hostname: string }>(
      'SELECT hostname FROM store_domain WHERE store_id = $1 AND is_primary',
      [store.id],
    );
    expect(primaries.rows).toEqual([{ hostname: 'brand-a.example' }]);
    await expect(addDomain(hq, store.id, { hostname: 'brand-a.example' })).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('a new default currency/locale becomes the single default and is mirrored on the store', async () => {
    const store = (await listStores(hq)).items.find((s) => s.code === 'brand-a')!;
    const currencies = await addCurrency(hq, store.id, 'USD', { isDefault: true }, actor);
    expect(currencies.filter((c) => c.is_default).map((c) => c.currency)).toEqual(['USD']);
    expect(currencies.map((c) => c.currency).sort()).toEqual(['EUR', 'GBP', 'USD']);
    expect((await getStore(hq, store.id)).default_currency).toBe('USD');

    const locales = await addLocale(hq, store.id, 'fr-FR', {}, actor);
    expect(locales.map((l) => l.locale).sort()).toEqual(['de-DE', 'en-GB', 'fr-FR']);
    expect(locales.filter((l) => l.is_default).map((l) => l.locale)).toEqual(['en-GB']);

    const last = await hq.query<{ payload: { changed_fields: string[] } }>(
      `SELECT payload FROM outbox WHERE aggregate_id = $1 AND topic = 'store.updated' ORDER BY seq DESC LIMIT 1`,
      [store.id],
    );
    expect(last.rows[0]!.payload.changed_fields).toEqual(['default_currency']);
  });
});

describe('registry: sales channels and api keys', () => {
  it('creates channels (unique code per store) and keys whose plain value is returned once', async () => {
    const store = (await listStores(hq)).items.find((s) => s.code === 'brand-a')!;
    const web = await createSalesChannel(
      hq,
      store.id,
      { code: 'web', name: 'Web', type: 'web' },
      actor,
    );
    expect(web).toMatchObject({ code: 'web', type: 'web', is_active: true });
    await expect(
      createSalesChannel(hq, store.id, { code: 'web', name: 'Web 2', type: 'app' }),
    ).rejects.toMatchObject({ code: 'conflict' });

    const created = await createApiKey(
      hq,
      store.id,
      { name: 'storefront', type: 'publishable', sales_channel_id: web.id },
      actor,
    );
    expect(created.key).toMatch(/^pk_brand-a_[0-9a-f]{40}$/);
    expect(created.key_prefix).toBe(created.key.slice(0, 8));
    expect(created.sales_channel_id).toBe(web.id);

    const stored = await hq.query<{ key_hash: string }>(
      'SELECT key_hash FROM store_api_key WHERE id = $1',
      [created.id],
    );
    expect(stored.rows[0]!.key_hash).toBe(createHash('sha256').update(created.key).digest('hex'));

    const listed = await listApiKeys(hq, store.id);
    expect(listed).toHaveLength(1);
    expect(Object.keys(listed[0]!)).not.toContain('key');
    expect(JSON.stringify(listed)).not.toContain(created.key);

    const audit = await hq.query<{ after: Record<string, unknown> }>(
      `SELECT after FROM audit_log WHERE entity_id = $1`,
      [created.id],
    );
    expect(JSON.stringify(audit.rows[0]!.after)).not.toContain(created.key);

    const revoked = await revokeApiKey(hq, store.id, created.id, actor);
    expect(revoked.revoked_at).not.toBeNull();
    await expect(revokeApiKey(hq, store.id, created.id)).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(
      createApiKey(hq, store.id, { name: 'x', type: 'secret', sales_channel_id: LE }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('outbox helper', () => {
  it('an invalid event aborts the whole transaction (no row, no outbox entry)', async () => {
    const store = (await listStores(hq)).items.find((s) => s.code === 'brand-a')!;
    const before = await hq.query<{ n: string }>('SELECT count(*)::text AS n FROM outbox');
    await expect(
      hq.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO sales_channel (organization_id, store_id, code, name, type) VALUES ($1, $2, 'pos-1', 'POS', 'pos')`,
          [ORG, store.id],
        );
        await withEvents(tx, [
          {
            event_id: '20000000-0000-4000-8000-0000000000ee',
            topic: 'store.updated',
            version: 1,
            occurred_at: new Date().toISOString(),
            organization_id: ORG,
            store_id: store.id,
            aggregate_type: 'store',
            aggregate_id: store.id,
            actor: { type: 'system', id: null },
            // missing `code` and `changed_fields` → schema violation
            payload: { store_id: store.id, status: 'active' } as never,
          },
        ]);
      }),
    ).rejects.toThrow(/invalid event store.updated/);
    const after = await hq.query<{ n: string }>('SELECT count(*)::text AS n FROM outbox');
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    const pos = await hq.query(`SELECT id FROM sales_channel WHERE code = 'pos-1'`);
    expect(pos.rowCount).toBe(0);
  });

  it('AppError carries the contract status', () => {
    expect(new AppError('not_found', 'x').status).toBe(404);
    expect(new AppError('conflict', 'x', { a: 1 }).toBody()).toEqual({
      code: 'conflict',
      message: 'x',
      details: { a: 1 },
    });
  });
});
