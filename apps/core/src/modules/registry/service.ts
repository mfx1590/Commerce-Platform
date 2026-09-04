// Store & channel registry over packages/db migration 0003 (store, store_domain, store_locale, store_currency,
// sales_channel, store_api_key). Every function takes a ScopedClient from @platform/db and runs ONE transaction:
// the row change, the audit_log row and the outbox rows commit or roll back together. RLS decides visibility.
import { createHash, randomBytes } from 'node:crypto';
import type { Queryable, ScopedClient } from '@platform/db';
import type { EventEnvelope } from '@platform/events';
import { SYSTEM_ACTOR, writeAudit, type Actor } from '../../lib/audit';
import { conflict, forbidden, mapPgError, notFound, validationError } from '../../lib/errors';
import { buildEvent, eventActor, withEvents } from '../../outbox/with-events';
import type {
  ApiKey,
  ApiKeyCreated,
  ApiKeyInput,
  Domain,
  DomainInput,
  Page,
  PageQuery,
  SalesChannel,
  SalesChannelInput,
  Store,
  StoreCurrency,
  StoreInput,
  StoreLocale,
  StoreRow,
} from './types';

const CODE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CURRENCY = /^[A-Z]{3}$/;
const COUNTRY = /^[A-Z]{2}$/;
const STORE_STATUSES = ['draft', 'active', 'paused', 'archived'] as const;
const CHANNEL_TYPES = ['web', 'app', 'marketplace', 'pos'] as const;
const KEY_TYPES = ['publishable', 'secret'] as const;

/** Fields of `store` a client may set; `organization_id`, `next_order_number`, timestamps are never client-set. */
const STORE_COLUMNS = [
  'legal_entity_id',
  'code',
  'name',
  'status',
  'default_currency',
  'default_locale',
  'default_country',
  'timezone',
  'content_space_id',
  'search_index',
  'theme',
  'settings',
] as const;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

function organizationOf(client: ScopedClient): string {
  return client.context.organizationId;
}

function requireOrganizationScope(client: ScopedClient, what: string): void {
  if (client.scope !== 'organization') throw forbidden(`${what} requires organization scope`);
}

export function toStore(r: StoreRow): Store {
  return {
    id: r.id,
    legal_entity_id: r.legal_entity_id,
    code: r.code,
    name: r.name,
    status: r.status,
    default_currency: r.default_currency,
    default_locale: r.default_locale,
    default_country: r.default_country,
    timezone: r.timezone,
    content_space_id: r.content_space_id,
    search_index: r.search_index,
    psp_account_id: r.psp_account_id,
    theme: r.theme ?? {},
    settings: r.settings ?? {},
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

function validateStoreInput(input: StoreInput, mode: 'create' | 'update'): void {
  const problems: Record<string, string> = {};
  if (mode === 'create') {
    for (const k of [
      'legal_entity_id',
      'code',
      'name',
      'default_currency',
      'default_locale',
      'default_country',
    ] as const) {
      if (input[k] === undefined || input[k] === null || input[k] === '') problems[k] = 'required';
    }
  }
  if (input.code !== undefined && !CODE.test(input.code)) problems.code = 'lowercase kebab-case';
  if (input.default_currency !== undefined && !CURRENCY.test(input.default_currency))
    problems.default_currency = 'ISO-4217 upper-case';
  if (input.default_country !== undefined && !COUNTRY.test(input.default_country))
    problems.default_country = 'ISO-3166-1 alpha-2';
  if (input.status !== undefined && !STORE_STATUSES.includes(input.status))
    problems.status = `one of ${STORE_STATUSES.join(', ')}`;
  for (const c of input.currencies ?? []) if (!CURRENCY.test(c)) problems.currencies = 'ISO-4217';
  if (Object.keys(problems).length) throw validationError('invalid store input', problems);
}

async function loadStore(tx: Queryable, id: string): Promise<StoreRow> {
  const r = await tx.query<StoreRow>('SELECT * FROM store WHERE id = $1', [id]);
  const row = r.rows[0];
  if (!row) throw notFound('store', id);
  return row;
}

/** Adds locale/currency rows (idempotent) and, when a default is named, makes it the single default. */
async function syncStoreSets(
  tx: Queryable,
  organizationId: string,
  storeId: string,
  locales: string[],
  defaultLocale: string | undefined,
  currencies: string[],
  defaultCurrency: string | undefined,
): Promise<void> {
  const allLocales = [...new Set([...(defaultLocale ? [defaultLocale] : []), ...locales])];
  for (const locale of allLocales) {
    await tx.query(
      `INSERT INTO store_locale (organization_id, store_id, locale) VALUES ($1, $2, $3)
       ON CONFLICT (store_id, locale) DO NOTHING`,
      [organizationId, storeId, locale],
    );
  }
  if (defaultLocale) {
    await tx.query(
      `UPDATE store_locale SET is_default = (locale = $2) WHERE store_id = $1 AND is_default <> (locale = $2)`,
      [storeId, defaultLocale],
    );
  }
  const allCurrencies = [
    ...new Set([...(defaultCurrency ? [defaultCurrency] : []), ...currencies]),
  ];
  for (const currency of allCurrencies) {
    await tx.query(
      `INSERT INTO store_currency (organization_id, store_id, currency) VALUES ($1, $2, $3)
       ON CONFLICT (store_id, currency) DO NOTHING`,
      [organizationId, storeId, currency],
    );
  }
  if (defaultCurrency) {
    await tx.query(
      `UPDATE store_currency SET is_default = (currency = $2) WHERE store_id = $1 AND is_default <> (currency = $2)`,
      [storeId, defaultCurrency],
    );
  }
}

// ---------------------------------------------------------------------------------------------------- stores

export async function listStores(client: ScopedClient, q: PageQuery = {}): Promise<Page<Store>> {
  const page = Math.max(1, q.page ?? 1);
  const limit = Math.min(100, Math.max(1, q.limit ?? 20));
  return client.transaction(async (tx) => {
    const total = await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM store');
    const rows = await tx.query<StoreRow>('SELECT * FROM store ORDER BY code LIMIT $1 OFFSET $2', [
      limit,
      (page - 1) * limit,
    ]);
    return { page, limit, total: Number(total.rows[0]?.n ?? 0), items: rows.rows.map(toStore) };
  });
}

export async function getStore(client: ScopedClient, id: string): Promise<Store> {
  return client.transaction(async (tx) => toStore(await loadStore(tx, id)));
}

/** Creates a store with its default locale/currency rows. Organization scope only (owner). Emits `store.created`. */
export async function createStore(
  client: ScopedClient,
  input: StoreInput,
  actor: Actor = SYSTEM_ACTOR,
): Promise<Store> {
  requireOrganizationScope(client, 'createStore');
  validateStoreInput(input, 'create');
  const organizationId = organizationOf(client);

  return client.transaction(async (tx) => {
    const inserted = await tx
      .query<StoreRow>(
        `INSERT INTO store (organization_id, legal_entity_id, code, name, status, default_currency, default_locale,
                            default_country, timezone, content_space_id, search_index, theme, settings)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING *`,
        [
          organizationId,
          input.legal_entity_id,
          input.code,
          input.name,
          input.status ?? 'draft',
          input.default_currency,
          input.default_locale,
          input.default_country,
          input.timezone ?? 'UTC',
          input.content_space_id ?? null,
          input.search_index ?? null,
          JSON.stringify(input.theme ?? {}),
          JSON.stringify(input.settings ?? {}),
        ],
      )
      .catch((e) => mapPgError(e, `store "${input.code}"`));
    const row = inserted.rows[0]!;

    await syncStoreSets(
      tx,
      organizationId,
      row.id,
      input.locales ?? [],
      row.default_locale,
      input.currencies ?? [],
      row.default_currency,
    );

    const store = toStore(row);
    await writeAudit(tx, {
      organizationId,
      storeId: row.id,
      actor,
      action: 'store.create',
      entityType: 'store',
      entityId: row.id,
      after: store,
    });
    await withEvents(tx, [
      await buildEvent({
        topic: 'store.created',
        organizationId,
        storeId: row.id,
        aggregateType: 'store',
        aggregateId: row.id,
        actor: eventActor(actor),
        payload: {
          store_id: row.id,
          legal_entity_id: row.legal_entity_id,
          code: row.code,
          name: row.name,
          status: row.status,
          default_currency: row.default_currency,
          default_locale: row.default_locale,
          default_country: row.default_country,
        },
      }),
    ]);
    return store;
  });
}

/** Partial update. Emits `store.updated` with the list of changed fields (no event when nothing changed). */
export async function updateStore(
  client: ScopedClient,
  id: string,
  patch: StoreInput,
  actor: Actor = SYSTEM_ACTOR,
): Promise<Store> {
  validateStoreInput(patch, 'update');
  const organizationId = organizationOf(client);

  return client.transaction(async (tx) => {
    const before = await loadStore(tx, id);
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const col of STORE_COLUMNS) {
      const value = patch[col as keyof StoreInput];
      if (value === undefined) continue;
      params.push(col === 'theme' || col === 'settings' ? JSON.stringify(value) : value);
      sets.push(`${col} = $${params.length}`);
    }
    let after = before;
    if (sets.length) {
      const r = await tx
        .query<StoreRow>(`UPDATE store SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params)
        .catch((e) => mapPgError(e, `store "${patch.code ?? before.code}"`));
      after = r.rows[0]!;
    }
    await syncStoreSets(
      tx,
      organizationId,
      id,
      patch.locales ?? [],
      patch.default_locale,
      patch.currencies ?? [],
      patch.default_currency,
    );

    const beforeStore = toStore(before);
    const afterStore = toStore(after);
    const changed = (Object.keys(afterStore) as (keyof Store)[]).filter(
      (k) => k !== 'updated_at' && JSON.stringify(beforeStore[k]) !== JSON.stringify(afterStore[k]),
    );
    if (patch.locales?.length) changed.push('locales' as keyof Store);
    if (patch.currencies?.length) changed.push('currencies' as keyof Store);
    if (changed.length === 0) return afterStore;

    await writeAudit(tx, {
      organizationId,
      storeId: id,
      actor,
      action: 'store.update',
      entityType: 'store',
      entityId: id,
      before: beforeStore,
      after: afterStore,
    });
    await withEvents(tx, [
      await buildEvent({
        topic: 'store.updated',
        organizationId,
        storeId: id,
        aggregateType: 'store',
        aggregateId: id,
        actor: eventActor(actor),
        payload: {
          store_id: id,
          code: after.code,
          status: after.status,
          changed_fields: [...changed].sort(),
        },
      }),
    ]);
    return afterStore;
  });
}

// --------------------------------------------------------------------------------------------------- domains

interface DomainRow {
  id: string;
  hostname: string;
  is_primary: boolean;
  verified_at: Date | null;
}

const toDomain = (r: DomainRow): Domain => ({
  id: r.id,
  hostname: r.hostname,
  is_primary: r.is_primary,
  verified_at: r.verified_at ? iso(r.verified_at) : null,
});

export async function listDomains(client: ScopedClient, storeId: string): Promise<Domain[]> {
  return client.transaction(async (tx) => {
    await loadStore(tx, storeId);
    const r = await tx.query<DomainRow>(
      'SELECT id, hostname, is_primary, verified_at FROM store_domain WHERE store_id = $1 ORDER BY is_primary DESC, hostname',
      [storeId],
    );
    return r.rows.map(toDomain);
  });
}

/** Adds a hostname (globally unique). `is_primary` moves the primary flag: exactly one primary per store. */
export async function addDomain(
  client: ScopedClient,
  storeId: string,
  input: DomainInput,
  actor: Actor = SYSTEM_ACTOR,
): Promise<Domain> {
  const hostname = input.hostname?.trim().toLowerCase();
  if (!hostname || !/^[a-z0-9.-]+$/.test(hostname))
    throw validationError('invalid hostname', { hostname: 'lowercase hostname' });
  const organizationId = organizationOf(client);

  return client.transaction(async (tx) => {
    await loadStore(tx, storeId);
    const existing = await tx.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM store_domain WHERE store_id = $1',
      [storeId],
    );
    // The first domain of a store is primary by default; a later explicit primary demotes the current one.
    const isPrimary = input.is_primary ?? Number(existing.rows[0]?.n ?? 0) === 0;
    if (isPrimary) {
      await tx.query(
        'UPDATE store_domain SET is_primary = false WHERE store_id = $1 AND is_primary',
        [storeId],
      );
    }
    const r = await tx
      .query<DomainRow>(
        `INSERT INTO store_domain (organization_id, store_id, hostname, is_primary) VALUES ($1, $2, $3, $4)
         RETURNING id, hostname, is_primary, verified_at`,
        [organizationId, storeId, hostname, isPrimary],
      )
      .catch((e) => mapPgError(e, `domain "${hostname}"`));
    const domain = toDomain(r.rows[0]!);
    await writeAudit(tx, {
      organizationId,
      storeId,
      actor,
      action: 'store_domain.create',
      entityType: 'store_domain',
      entityId: domain.id,
      after: domain,
    });
    return domain;
  });
}

// ---------------------------------------------------------------------------------------- locales / currencies

export async function listLocales(client: ScopedClient, storeId: string): Promise<StoreLocale[]> {
  const r = await client.query<StoreLocale>(
    'SELECT id, locale, is_default FROM store_locale WHERE store_id = $1 ORDER BY is_default DESC, locale',
    [storeId],
  );
  return r.rows;
}

export async function listCurrencies(
  client: ScopedClient,
  storeId: string,
): Promise<StoreCurrency[]> {
  const r = await client.query<StoreCurrency>(
    'SELECT id, currency, is_default FROM store_currency WHERE store_id = $1 ORDER BY is_default DESC, currency',
    [storeId],
  );
  return r.rows;
}

/** Adds a locale; `isDefault` also changes `store.default_locale` (and emits `store.updated`). */
export async function addLocale(
  client: ScopedClient,
  storeId: string,
  locale: string,
  opts: { isDefault?: boolean } = {},
  actor: Actor = SYSTEM_ACTOR,
): Promise<StoreLocale[]> {
  if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(locale))
    throw validationError('invalid locale', { locale: 'BCP-47' });
  if (opts.isDefault) {
    await updateStore(client, storeId, { default_locale: locale }, actor);
  } else {
    await client.transaction(async (tx) => {
      const store = await loadStore(tx, storeId);
      await syncStoreSets(tx, store.organization_id, storeId, [locale], undefined, [], undefined);
      await writeAudit(tx, {
        organizationId: store.organization_id,
        storeId,
        actor,
        action: 'store_locale.create',
        entityType: 'store',
        entityId: storeId,
        after: { locale },
      });
    });
  }
  return listLocales(client, storeId);
}

/** Adds a currency; `isDefault` also changes `store.default_currency` (and emits `store.updated`). */
export async function addCurrency(
  client: ScopedClient,
  storeId: string,
  currency: string,
  opts: { isDefault?: boolean } = {},
  actor: Actor = SYSTEM_ACTOR,
): Promise<StoreCurrency[]> {
  if (!CURRENCY.test(currency)) throw validationError('invalid currency', { currency: 'ISO-4217' });
  if (opts.isDefault) {
    await updateStore(client, storeId, { default_currency: currency }, actor);
  } else {
    await client.transaction(async (tx) => {
      const store = await loadStore(tx, storeId);
      await syncStoreSets(tx, store.organization_id, storeId, [], undefined, [currency], undefined);
      await writeAudit(tx, {
        organizationId: store.organization_id,
        storeId,
        actor,
        action: 'store_currency.create',
        entityType: 'store',
        entityId: storeId,
        after: { currency },
      });
    });
  }
  return listCurrencies(client, storeId);
}

// ---------------------------------------------------------------------------------------------- sales channels

interface ChannelRow {
  id: string;
  code: string;
  name: string;
  type: SalesChannel['type'];
  is_active: boolean;
}

const toChannel = (r: ChannelRow): SalesChannel => ({
  id: r.id,
  code: r.code,
  name: r.name,
  type: r.type,
  is_active: r.is_active,
});

export async function listSalesChannels(
  client: ScopedClient,
  storeId: string,
): Promise<SalesChannel[]> {
  return client.transaction(async (tx) => {
    await loadStore(tx, storeId);
    const r = await tx.query<ChannelRow>(
      'SELECT id, code, name, type, is_active FROM sales_channel WHERE store_id = $1 ORDER BY code',
      [storeId],
    );
    return r.rows.map(toChannel);
  });
}

export async function createSalesChannel(
  client: ScopedClient,
  storeId: string,
  input: SalesChannelInput,
  actor: Actor = SYSTEM_ACTOR,
): Promise<SalesChannel> {
  const problems: Record<string, string> = {};
  if (!input.code || !CODE.test(input.code)) problems.code = 'lowercase kebab-case';
  if (!input.name) problems.name = 'required';
  if (!CHANNEL_TYPES.includes(input.type)) problems.type = `one of ${CHANNEL_TYPES.join(', ')}`;
  if (Object.keys(problems).length) throw validationError('invalid sales channel input', problems);
  const organizationId = organizationOf(client);

  return client.transaction(async (tx) => {
    await loadStore(tx, storeId);
    const r = await tx
      .query<ChannelRow>(
        `INSERT INTO sales_channel (organization_id, store_id, code, name, type) VALUES ($1, $2, $3, $4, $5)
         RETURNING id, code, name, type, is_active`,
        [organizationId, storeId, input.code, input.name, input.type],
      )
      .catch((e) => mapPgError(e, `sales channel "${input.code}"`));
    const channel = toChannel(r.rows[0]!);
    await writeAudit(tx, {
      organizationId,
      storeId,
      actor,
      action: 'sales_channel.create',
      entityType: 'sales_channel',
      entityId: channel.id,
      after: channel,
    });
    return channel;
  });
}

// --------------------------------------------------------------------------------------------------- api keys

interface ApiKeyRow {
  id: string;
  name: string;
  type: ApiKey['type'];
  key_prefix: string;
  sales_channel_id: string | null;
  revoked_at: Date | null;
  created_at: Date;
}

const toApiKey = (r: ApiKeyRow): ApiKey => ({
  id: r.id,
  name: r.name,
  type: r.type,
  key_prefix: r.key_prefix,
  sales_channel_id: r.sales_channel_id,
  revoked_at: r.revoked_at ? iso(r.revoked_at) : null,
  created_at: iso(r.created_at),
});

/** Plain key format: `pk_<store code>_<40 hex>` / `sk_<store code>_<40 hex>`. Stored: sha256 hex + first 8 chars. */
export function generatePlainKey(type: ApiKey['type'], storeCode: string): string {
  return `${type === 'publishable' ? 'pk' : 'sk'}_${storeCode}_${randomBytes(20).toString('hex')}`;
}

export const hashKey = sha256;

export async function listApiKeys(client: ScopedClient, storeId: string): Promise<ApiKey[]> {
  return client.transaction(async (tx) => {
    await loadStore(tx, storeId);
    const r = await tx.query<ApiKeyRow>(
      `SELECT id, name, type, key_prefix, sales_channel_id, revoked_at, created_at
       FROM store_api_key WHERE store_id = $1 ORDER BY created_at, name`,
      [storeId],
    );
    return r.rows.map(toApiKey);
  });
}

/** Creates a key; the plain key is returned exactly once and never stored. */
export async function createApiKey(
  client: ScopedClient,
  storeId: string,
  input: ApiKeyInput,
  actor: Actor = SYSTEM_ACTOR,
): Promise<ApiKeyCreated> {
  const problems: Record<string, string> = {};
  if (!input.name) problems.name = 'required';
  if (!KEY_TYPES.includes(input.type)) problems.type = `one of ${KEY_TYPES.join(', ')}`;
  if (Object.keys(problems).length) throw validationError('invalid api key input', problems);
  const organizationId = organizationOf(client);

  return client.transaction(async (tx) => {
    const store = await loadStore(tx, storeId);
    if (input.sales_channel_id) {
      const sc = await tx.query('SELECT id FROM sales_channel WHERE id = $1 AND store_id = $2', [
        input.sales_channel_id,
        storeId,
      ]);
      if (sc.rowCount === 0) throw notFound('sales channel', input.sales_channel_id);
    }
    const plain = generatePlainKey(input.type, store.code);
    const r = await tx
      .query<ApiKeyRow>(
        `INSERT INTO store_api_key (organization_id, store_id, name, type, key_prefix, key_hash, sales_channel_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, name, type, key_prefix, sales_channel_id, revoked_at, created_at`,
        [
          organizationId,
          storeId,
          input.name,
          input.type,
          plain.slice(0, 8),
          sha256(plain),
          input.sales_channel_id ?? null,
        ],
      )
      .catch((e) => mapPgError(e, 'api key'));
    const key = toApiKey(r.rows[0]!);
    await writeAudit(tx, {
      organizationId,
      storeId,
      actor,
      action: 'store_api_key.create',
      entityType: 'store_api_key',
      entityId: key.id,
      after: key, // never the plain key or its hash
    });
    return { ...key, key: plain };
  });
}

export async function revokeApiKey(
  client: ScopedClient,
  storeId: string,
  keyId: string,
  actor: Actor = SYSTEM_ACTOR,
): Promise<ApiKey> {
  const organizationId = organizationOf(client);
  return client.transaction(async (tx) => {
    const before = await tx.query<ApiKeyRow>(
      `SELECT id, name, type, key_prefix, sales_channel_id, revoked_at, created_at
       FROM store_api_key WHERE id = $1 AND store_id = $2`,
      [keyId, storeId],
    );
    if (!before.rows[0]) throw notFound('api key', keyId);
    if (before.rows[0].revoked_at) throw conflict('api key already revoked');
    const r = await tx.query<ApiKeyRow>(
      `UPDATE store_api_key SET revoked_at = now() WHERE id = $1
       RETURNING id, name, type, key_prefix, sales_channel_id, revoked_at, created_at`,
      [keyId],
    );
    const key = toApiKey(r.rows[0]!);
    await writeAudit(tx, {
      organizationId,
      storeId,
      actor,
      action: 'store_api_key.revoke',
      entityType: 'store_api_key',
      entityId: keyId,
      before: toApiKey(before.rows[0]),
      after: key,
    });
    return key;
  });
}

export type { EventEnvelope };
