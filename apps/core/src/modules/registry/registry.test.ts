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
  listDomains,
  listSalesChannels,
  listStores,
  revokeApiKey,
  updateDomain,
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
      `SELECT payload FROM outbox WHERE aggregate_id = $1 AND topic = 'store.updated' ORDER BY seq DESC LIMIT 2`,
      [store.id],
    );
    // USD became the default AND joined the enabled set (#279: the sets are part of the store now).
    expect(last.rows[1]!.payload.changed_fields).toEqual(['currencies', 'default_currency']);
    // A plain addition writes the outbox too (every registry state change does).
    expect(last.rows[0]!.payload.changed_fields).toEqual(['locales']);
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

    await expect(
      createApiKey(hq, store.id, { name: 'x', type: 'secret', sales_channel_id: LE }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('registry settings (Admin API 0.4.7, #279)', () => {
  const brand = async (code: string) => (await listStores(hq)).items.find((s) => s.code === code)!;
  /** `changed_fields` of every `store.updated` of the store, oldest first. */
  const storeUpdates = async (storeId: string) =>
    (
      await hq.query<{ payload: { changed_fields: string[] } }>(
        `SELECT payload FROM outbox WHERE aggregate_id = $1 AND topic = 'store.updated' ORDER BY seq`,
        [storeId],
      )
    ).rows.map((r) => r.payload);
  const setRows = async (table: 'store_currency' | 'store_locale', storeId: string) => {
    const column = table === 'store_currency' ? 'currency' : 'locale';
    const r = await hq.query<{ value: string; is_default: boolean }>(
      `SELECT ${column}::text AS value, is_default FROM ${table} WHERE store_id = $1 ORDER BY 1`,
      [storeId],
    );
    return r.rows.map((x) => (x.is_default ? `${x.value}*` : x.value));
  };

  it('store reads return the enabled sets with the default first (get, list, create)', async () => {
    const store = await brand('brand-a');
    expect(store.currencies).toEqual(['USD', 'EUR', 'GBP']);
    expect(store.locales).toEqual(['en-GB', 'de-DE', 'fr-FR']);
    const read = await getStore(hq, store.id);
    expect(read.currencies).toEqual(store.currencies);
    expect(read.locales).toEqual(store.locales);

    const bare = await createStore(
      hq,
      {
        legal_entity_id: LE,
        code: 'brand-d',
        name: 'Brand D',
        default_currency: 'EUR',
        default_locale: 'en-GB',
        default_country: 'NL',
      },
      actor,
    );
    expect(bare.currencies).toEqual(['EUR']);
    expect(bare.locales).toEqual(['en-GB']);
  });

  it('updateStore replaces a given set (never the default), leaves an omitted one alone, and reports real changes only', async () => {
    const store = await brand('brand-a');
    const before = (await storeUpdates(store.id)).length;

    // Replacement: EUR goes; the default (USD) stays although the list does not name it.
    const replaced = await updateStore(hq, store.id, { currencies: ['GBP'] }, actor);
    expect(replaced.currencies).toEqual(['USD', 'GBP']);
    expect(replaced.locales).toEqual(['en-GB', 'de-DE', 'fr-FR']); // omitted = unchanged
    expect(await setRows('store_currency', store.id)).toEqual(['GBP', 'USD*']);

    // Neither field in the patch: both sets untouched.
    const renamed = await updateStore(hq, store.id, { name: 'Brand A' }, actor);
    expect(renamed.currencies).toEqual(['USD', 'GBP']);
    expect(renamed.locales).toEqual(['en-GB', 'de-DE', 'fr-FR']);

    // An empty list is a replacement too: the default alone remains.
    const emptied = await updateStore(hq, store.id, { locales: [] }, actor);
    expect(emptied.locales).toEqual(['en-GB']);
    expect(await setRows('store_locale', store.id)).toEqual(['en-GB*']);

    // A default given in the same request is the one kept; the former default is an ordinary member and goes.
    const moved = await updateStore(
      hq,
      store.id,
      { default_currency: 'EUR', currencies: ['CHF'] },
      actor,
    );
    expect(moved.default_currency).toBe('EUR');
    expect(moved.currencies).toEqual(['EUR', 'CHF']);
    expect(await setRows('store_currency', store.id)).toEqual(['CHF', 'EUR*']);

    // A new default without the list joins the set; nothing is removed.
    const relocated = await updateStore(hq, store.id, { default_locale: 'nl-NL' }, actor);
    expect(relocated.locales).toEqual(['nl-NL', 'en-GB']);
    expect(await setRows('store_locale', store.id)).toEqual(['en-GB', 'nl-NL*']);

    // The same sets again (any order): nothing changed, nothing emitted.
    await updateStore(
      hq,
      store.id,
      { currencies: ['CHF', 'EUR'], locales: ['en-GB', 'nl-NL'] },
      actor,
    );

    expect((await storeUpdates(store.id)).slice(before).map((p) => p.changed_fields)).toEqual([
      ['currencies'],
      ['name'],
      ['locales'],
      ['currencies', 'default_currency'],
      ['default_locale', 'locales'],
    ]);
  });

  it('a refused update changes neither the store nor its sets', async () => {
    const store = await brand('brand-a');
    await expect(
      updateStore(hq, store.id, { code: 'brand-b', currencies: ['JPY'] }, actor),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect((await getStore(hq, store.id)).currencies).toEqual(['EUR', 'CHF']);
  });

  it('no foreign key references store_currency / store_locale: a removal cannot be refused today', async () => {
    // When this fails, a constraint can now refuse the DELETE in syncStoreSet: it must answer 409 naming the
    // constraint (refuseSetRemoval) — add that case here.
    const fks = await db.owner.query(
      `SELECT conname FROM pg_constraint
       WHERE contype = 'f' AND confrelid IN ('store_currency'::regclass, 'store_locale'::regclass)`,
    );
    expect(fks.rows).toEqual([]);
  });

  it('revokeApiKey: idempotent, never the last live publishable key, store.updated without key material', async () => {
    const store = await brand('brand-a');
    const [web] = await listSalesChannels(hq, store.id);
    const [first] = await listApiKeys(hq, store.id); // "storefront": the only live publishable key
    // A secret key is not a storefront credential: it does not make the publishable key revocable.
    const secret = await createApiKey(hq, store.id, { name: 'backend', type: 'secret' }, actor);
    await expect(revokeApiKey(hq, store.id, first!.id, actor)).rejects.toMatchObject({
      code: 'last_live_key',
      status: 409,
      details: { key_id: first!.id },
    });

    const second = await createApiKey(
      hq,
      store.id,
      { name: 'storefront 2', type: 'publishable', sales_channel_id: web!.id },
      actor,
    );
    const before = (await storeUpdates(store.id)).length;
    const revoked = await revokeApiKey(hq, store.id, first!.id, actor);
    expect(revoked.revoked_at).not.toBeNull();
    // Idempotent: the same row with the same revoked_at, one audit row, one event.
    expect(await revokeApiKey(hq, store.id, first!.id, actor)).toEqual(revoked);
    const audit = await hq.query(
      `SELECT 1 FROM audit_log WHERE entity_id = $1 AND action = 'store_api_key.revoke'`,
      [first!.id],
    );
    expect(audit.rows).toHaveLength(1);
    const emitted = (await storeUpdates(store.id)).slice(before);
    expect(emitted).toEqual([
      { store_id: store.id, code: 'brand-a', status: 'active', changed_fields: ['api_keys'] },
    ]);
    expect(JSON.stringify(emitted)).not.toContain(first!.key_prefix);

    // The revoked key no longer counts: "storefront 2" is now the last live one.
    await expect(revokeApiKey(hq, store.id, second.id, actor)).rejects.toMatchObject({
      code: 'last_live_key',
    });
    // Secret keys are never refused.
    expect((await revokeApiKey(hq, store.id, secret.id, actor)).revoked_at).not.toBeNull();

    // Unknown key, and a key reached through another store: 404.
    await expect(revokeApiKey(hq, store.id, LE, actor)).rejects.toMatchObject({
      code: 'not_found',
    });
    const other = await brand('brand-b');
    await expect(revokeApiKey(hq, other.id, second.id, actor)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('two concurrent revokes of the last two live publishable keys: exactly one goes through', async () => {
    const store = await brand('brand-a');
    const [web] = await listSalesChannels(hq, store.id);
    const third = await createApiKey(
      hq,
      store.id,
      { name: 'storefront 3', type: 'publishable', sales_channel_id: web!.id },
      actor,
    );
    const live = (await listApiKeys(hq, store.id)).filter(
      (k) => k.type === 'publishable' && !k.revoked_at,
    );
    expect(live.map((k) => k.id)).toContain(third.id);
    expect(live).toHaveLength(2);

    const results = await Promise.allSettled(
      live.map((k) => revokeApiKey(hq, store.id, k.id, actor)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: 'last_live_key', status: 409 });
    const left = (await listApiKeys(hq, store.id)).filter(
      (k) => k.type === 'publishable' && !k.revoked_at,
    );
    expect(left).toHaveLength(1);
  });

  it('updateDomain moves the primary in one transaction; clearing the primary is a 409; a no-op writes nothing', async () => {
    const store = await brand('brand-a');
    const domains = await listDomains(hq, store.id);
    const primary = domains.find((d) => d.is_primary)!;
    const other = domains.find((d) => !d.is_primary)!;
    const before = (await storeUpdates(store.id)).length;

    await expect(
      updateDomain(hq, store.id, primary.id, { is_primary: false }, actor),
    ).rejects.toMatchObject({ code: 'conflict', status: 409 });
    // Requests that change nothing answer the row as it is.
    expect(await updateDomain(hq, store.id, primary.id, { is_primary: true }, actor)).toEqual(
      primary,
    );
    expect(await updateDomain(hq, store.id, other.id, { is_primary: false }, actor)).toEqual(other);
    expect((await storeUpdates(store.id)).slice(before)).toEqual([]);

    const moved = await updateDomain(hq, store.id, other.id, { is_primary: true }, actor);
    expect(moved).toEqual({ ...other, is_primary: true });
    const primaries = await hq.query<{ id: string }>(
      'SELECT id FROM store_domain WHERE store_id = $1 AND is_primary',
      [store.id],
    );
    expect(primaries.rows).toEqual([{ id: other.id }]);

    const emitted = (await storeUpdates(store.id)).slice(before);
    expect(emitted).toEqual([
      { store_id: store.id, code: 'brand-a', status: 'active', changed_fields: ['domains'] },
    ]);
    expect(JSON.stringify(emitted)).not.toContain(other.hostname);
    const audit = await hq.query<{ was: boolean; is: boolean }>(
      `SELECT (before->>'is_primary')::boolean AS was, (after->>'is_primary')::boolean AS is
       FROM audit_log WHERE entity_id = $1 AND action = 'store_domain.update'`,
      [other.id],
    );
    expect(audit.rows).toEqual([{ was: false, is: true }]);

    // Unknown domain, a domain of another store, and another store through a store-scoped client: 404.
    await expect(updateDomain(hq, store.id, LE, { is_primary: true }, actor)).rejects.toMatchObject(
      { code: 'not_found' },
    );
    const b = await brand('brand-b');
    const foreign = await addDomain(hq, b.id, { hostname: 'shop.brand-b.example' }, actor);
    await expect(
      updateDomain(hq, store.id, foreign.id, { is_primary: true }, actor),
    ).rejects.toMatchObject({ code: 'not_found' });
    const scopedA = createTenantClient(db.app, { organizationId: ORG, storeIds: [store.id] });
    await expect(
      updateDomain(scopedA, b.id, foreign.id, { is_primary: true }, actor),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

// #308 review: updateStore read the store without a lock, so a set replacement acted on the default it had read
// before a concurrent default change committed (new default row deleted or left unflagged, old default
// re-flagged), and two overlapping replacements left the union. The store row is now locked before the read.
describe('registry settings under concurrency (#308 review)', () => {
  const rows = async (table: 'store_currency' | 'store_locale', storeId: string) => {
    const column = table === 'store_currency' ? 'currency' : 'locale';
    const r = await hq.query<{ value: string; is_default: boolean }>(
      `SELECT ${column}::text AS value, is_default FROM ${table} WHERE store_id = $1 ORDER BY 1`,
      [storeId],
    );
    return r.rows.map((x) => (x.is_default ? `${x.value}*` : x.value));
  };
  const fresh = (code: string) =>
    createStore(
      hq,
      {
        legal_entity_id: LE,
        code,
        name: code,
        default_currency: 'EUR',
        default_locale: 'en-GB',
        default_country: 'NL',
        currencies: ['EUR', 'GBP'],
        locales: ['en-GB', 'de-DE'],
      },
      actor,
    );

  it('a replacement that starts while a default change is uncommitted waits for it: the new default keeps its row and is the only default', async () => {
    const store = await fresh('race-held');
    // T1, held open by hand: default → USD and set → [USD], exactly what updateStore writes. Its UPDATE of
    // the store row holds the lock updateStore now asks for first.
    let commitT1!: () => void;
    const gate = new Promise<void>((resolve) => (commitT1 = resolve));
    let t1Wrote!: () => void;
    const wrote = new Promise<void>((resolve) => (t1Wrote = resolve));
    const t1 = hq.transaction(async (tx) => {
      await tx.query(`UPDATE store SET default_currency = 'USD' WHERE id = $1`, [store.id]);
      await tx.query(`DELETE FROM store_currency WHERE store_id = $1 AND currency <> 'USD'`, [
        store.id,
      ]);
      await tx.query(
        `INSERT INTO store_currency (organization_id, store_id, currency, is_default)
         VALUES ($1, $2, 'USD', true)`,
        [ORG, store.id],
      );
      t1Wrote();
      await gate;
    });
    await wrote;

    // T2 starts now; unlocked, it had read "default EUR" here and later re-flagged EUR over T1's USD.
    let settled = false;
    const t2 = updateStore(hq, store.id, { currencies: ['EUR', 'GBP'] }, actor).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(settled).toBe(false);
    commitT1();
    await t1;
    const after = await t2;

    // T1 then T2, as if they had run one after the other: USD is the default and has its row; T2's list
    // replaced the rest.
    expect(after.default_currency).toBe('USD');
    expect(after.currencies).toEqual(['USD', 'EUR', 'GBP']);
    expect(await rows('store_currency', store.id)).toEqual(['EUR', 'GBP', 'USD*']);
  });

  it('a default change racing a replacement (Promise.allSettled): the default row exists and the set is one serial outcome', async () => {
    const store = await fresh('race-default');
    for (let round = 0; round < 6; round++) {
      const results = await Promise.allSettled([
        updateStore(hq, store.id, { default_currency: 'USD', currencies: ['USD'] }, actor),
        updateStore(hq, store.id, { currencies: ['EUR', 'GBP'] }, actor),
      ]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      expect((await getStore(hq, store.id)).default_currency).toBe('USD');
      // default change last → [USD]; replacement last → its list plus the (new) default
      expect([['USD*'], ['EUR', 'GBP', 'USD*']]).toContainEqual(
        await rows('store_currency', store.id),
      );
      await updateStore(hq, store.id, { default_currency: 'EUR', currencies: ['GBP'] }, actor);
      expect(await rows('store_currency', store.id)).toEqual(['EUR*', 'GBP']);
    }
  });

  it("two overlapping replacements leave one caller's set, never the union (currencies and locales)", async () => {
    const store = await fresh('race-union');
    for (let round = 0; round < 6; round++) {
      const results = await Promise.allSettled([
        updateStore(hq, store.id, { currencies: ['GBP'], locales: ['de-DE'] }, actor),
        updateStore(hq, store.id, { currencies: ['CHF'], locales: ['fr-FR'] }, actor),
      ]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      const currencies = await rows('store_currency', store.id);
      const locales = await rows('store_locale', store.id);
      expect([
        ['EUR*', 'GBP'],
        ['CHF', 'EUR*'],
      ]).toContainEqual(currencies);
      expect([
        ['de-DE', 'en-GB*'],
        ['en-GB*', 'fr-FR'],
      ]).toContainEqual(locales);
      // Both sets come from the same caller: the whole request is one transaction behind the lock.
      expect(currencies.includes('GBP')).toBe(locales.includes('de-DE'));
      await updateStore(hq, store.id, { currencies: [], locales: [] }, actor);
    }
  });

  it('concurrent add-only calls (addCurrency / addLocale) both land', async () => {
    const store = await fresh('race-add');
    const results = await Promise.allSettled([
      addCurrency(hq, store.id, 'JPY', {}, actor),
      addCurrency(hq, store.id, 'CHF', {}, actor),
      addLocale(hq, store.id, 'fr-FR', {}, actor),
      addLocale(hq, store.id, 'nl-NL', {}, actor),
    ]);
    expect(results.map((r) => r.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'fulfilled',
      'fulfilled',
    ]);
    expect(await rows('store_currency', store.id)).toEqual(['CHF', 'EUR*', 'GBP', 'JPY']);
    expect(await rows('store_locale', store.id)).toEqual(['de-DE', 'en-GB*', 'fr-FR', 'nl-NL']);
  });
});

// Manager ruling on the #308 review: a state change in apps/core writes the outbox in the same transaction —
// an audit row alone is not enough. These five used to write audit only.
describe('registry: every mutation writes store.updated (outbox completeness)', () => {
  it('addDomain, addLocale, addCurrency, createSalesChannel, createApiKey each emit one event naming the area — no hostname, no key material; a no-op emits nothing', async () => {
    const store = await createStore(
      hq,
      {
        legal_entity_id: LE,
        code: 'outbox-complete',
        name: 'Outbox complete',
        default_currency: 'EUR',
        default_locale: 'en-GB',
        default_country: 'NL',
      },
      actor,
    );
    const updates = async () =>
      (
        await hq.query<{ payload: Record<string, unknown> }>(
          `SELECT payload FROM outbox WHERE aggregate_id = $1 AND topic = 'store.updated' ORDER BY seq`,
          [store.id],
        )
      ).rows.map((r) => r.payload);

    const first = await addDomain(
      hq,
      store.id,
      { hostname: 'shop.outbox-complete.example' },
      actor,
    );
    await addDomain(
      hq,
      store.id,
      { hostname: 'www.outbox-complete.example', is_primary: true },
      actor,
    );
    await addLocale(hq, store.id, 'fr-FR', {}, actor);
    await addLocale(hq, store.id, 'fr-FR', {}, actor); // already enabled: nothing changes, nothing emitted
    await addCurrency(hq, store.id, 'CHF', {}, actor);
    await addCurrency(hq, store.id, 'EUR', {}, actor); // the default is already in the set
    const channel = await createSalesChannel(
      hq,
      store.id,
      { code: 'web', name: 'Web', type: 'web' },
      actor,
    );
    const key = await createApiKey(
      hq,
      store.id,
      { name: 'storefront', type: 'publishable', sales_channel_id: channel.id },
      actor,
    );

    const emitted = await updates();
    expect(emitted.map((p) => p.changed_fields)).toEqual([
      ['domains'],
      ['domains'],
      ['locales'],
      ['currencies'],
      ['sales_channels'],
      ['api_keys'],
    ]);
    for (const payload of emitted) {
      expect(Object.keys(payload).sort()).toEqual(['changed_fields', 'code', 'status', 'store_id']);
      expect(payload).toMatchObject({ store_id: store.id, code: 'outbox-complete' });
    }
    const all = JSON.stringify(emitted);
    expect(all).not.toContain(first.hostname);
    expect(all).not.toContain('www.outbox-complete.example');
    expect(all).not.toContain(key.key);
    expect(all).not.toContain(key.key_prefix);
  });

  it('a refused mutation emits nothing (the event is in the same transaction)', async () => {
    const store = (await listStores(hq, { limit: 100 })).items.find(
      (s) => s.code === 'outbox-complete',
    )!;
    const count = async () =>
      Number(
        (
          await hq.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM outbox WHERE aggregate_id = $1`,
            [store.id],
          )
        ).rows[0]!.n,
      );
    const before = await count();
    await expect(
      addDomain(hq, store.id, { hostname: 'shop.outbox-complete.example' }, actor),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      createSalesChannel(hq, store.id, { code: 'web', name: 'Web again', type: 'web' }, actor),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      createApiKey(hq, store.id, { name: 'x', type: 'secret', sales_channel_id: LE }, actor),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(await count()).toBe(before);
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
