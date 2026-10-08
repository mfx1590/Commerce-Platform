// Store & channel registry over packages/db migration 0003 (store, store_domain, store_locale, store_currency,
// sales_channel, store_api_key). Every function takes a ScopedClient from @platform/db and runs ONE transaction:
// the row change, the audit_log row and the outbox rows commit or roll back together. RLS decides visibility.
import { createHash, randomBytes } from 'node:crypto';
import type { Queryable, ScopedClient } from '@platform/db';
import type { EventEnvelope } from '@platform/events';
import { SYSTEM_ACTOR, writeAudit, type Actor } from '../../lib/audit';
import {
  AppError,
  conflict,
  forbidden,
  mapPgError,
  notFound,
  validationError,
} from '../../lib/errors';
import { buildEvent, eventActor, withEvents } from '../../outbox';
import { storeReadiness } from './readiness';
import { validateStoreSettings } from './settings-schema';
import type {
  ApiKey,
  ApiKeyCreated,
  ApiKeyInput,
  Domain,
  DomainInput,
  DomainUpdate,
  Page,
  SalesChannel,
  SortOrder,
  StoreListQuery,
  StoreSortField,
  SalesChannelInput,
  Store,
  StoreCurrency,
  StoreInput,
  StoreLocale,
  StoreRow,
  Warehouse,
  LegalEntity,
  StoreRegistrar,
} from './types';

/* module-internal (onboarding.ts); not part of the public API in index.ts */ export const CODE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const CURRENCY = /^[A-Z]{3}$/;
export const COUNTRY = /^[A-Z]{2}$/;
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

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

export function organizationOf(client: ScopedClient): string {
  return client.context.organizationId;
}

export function requireOrganizationScope(client: ScopedClient, what: string): void {
  if (client.scope !== 'organization') throw forbidden(`${what} requires organization scope`);
}

/** The default first, then the rest in stored order: the contract's "always contains the default". */
const withDefault = (set: string[] | undefined, def: string): string[] => [
  def,
  ...(set ?? []).filter((v) => v !== def),
];

/**
 * A store row with its enabled sets (Admin API 0.4.7 `Store.currencies` / `Store.locales`, #279), default
 * first. RLS applies to the sub-selects like to any other read of the two tables.
 */
const STORE_SELECT = `SELECT s.*,
         ARRAY(SELECT c.currency::text FROM store_currency c WHERE c.store_id = s.id
               ORDER BY c.is_default DESC, c.currency) AS currencies,
         ARRAY(SELECT l.locale::text FROM store_locale l WHERE l.store_id = s.id
               ORDER BY l.is_default DESC, l.locale) AS locales
       FROM store s`;

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
    currencies: withDefault(r.currencies, r.default_currency),
    locales: withDefault(r.locales, r.default_locale),
    content_space_id: r.content_space_id,
    search_index: r.search_index,
    psp_account_id: r.psp_account_id,
    theme: r.theme ?? {},
    settings: r.settings ?? {},
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

export function validateStoreInput(input: StoreInput, mode: 'create' | 'update'): void {
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
  validateStoreSettings(input.settings); // 422, after the 400s: a well-formed body whose values cannot be used
}

export async function loadStore(tx: Queryable, id: string): Promise<StoreRow> {
  const r = await tx.query<StoreRow>(`${STORE_SELECT} WHERE s.id = $1`, [id]);
  const row = r.rows[0];
  if (!row) throw notFound('store', id);
  return row;
}

/**
 * Locks the store row for the rest of the transaction, THEN reads it with its sets. Everything that rewrites
 * the enabled sets or the defaults goes through this: without it two overlapping set replacements each act on
 * the store they read before the other committed — the second one deletes the first one's new default row and
 * re-flags the old default, or the two leave the union neither asked for (#308 review). The read is a second
 * statement on purpose: under READ COMMITTED a statement that waited for the lock still evaluates its
 * sub-selects on the snapshot it started with, so lock-and-read in one statement would return stale sets.
 * `FOR NO KEY UPDATE` is the lock an ordinary UPDATE of the row takes: writers of the store queue, while
 * inserts that reference the store (carts, orders — `FOR KEY SHARE` on this row) are not held up.
 */
export async function lockStore(tx: Queryable, id: string): Promise<StoreRow> {
  const locked = await tx.query('SELECT id FROM store WHERE id = $1 FOR NO KEY UPDATE', [id]);
  if (!locked.rows[0]) throw notFound('store', id);
  return loadStore(tx, id);
}

/**
 * A foreign key that refuses the removal of an enabled locale/currency is a 409 naming the constraint — never
 * a 500 and never a cascade. (No constraint references either table today; registry.test.ts pins that.)
 */
function refuseSetRemoval(err: unknown, what: string): never {
  const e = err as { code?: string; constraint?: string };
  if (e?.code === '23503') {
    throw conflict(`${what} is still in use and cannot be removed`, {
      constraint: e.constraint ?? null,
    });
  }
  throw err;
}

/**
 * Brings one enabled set (`store_locale` or `store_currency`) in line with the request (#279). The store's
 * default — given in the same request or current — always has a row and is the single default. A `requested`
 * list REPLACES the set: rows outside it are deleted (never the default), missing ones inserted; `[]` leaves
 * the default alone. `undefined` (field omitted) leaves the other rows untouched.
 */
async function syncStoreSet(
  tx: Queryable,
  set: { table: 'store_locale' | 'store_currency'; column: 'locale' | 'currency' },
  organizationId: string,
  storeId: string,
  requested: string[] | undefined,
  defaultValue: string,
): Promise<void> {
  const { table, column } = set; // literals from the two call sites below, never request input
  const target = [...new Set([defaultValue, ...(requested ?? [])])];
  if (requested !== undefined) {
    await tx
      .query(`DELETE FROM ${table} WHERE store_id = $1 AND ${column} <> ALL($2::text[])`, [
        storeId,
        target,
      ])
      .catch((e) => refuseSetRemoval(e, `a ${column} of the store`));
  }
  for (const value of target) {
    await tx.query(
      `INSERT INTO ${table} (organization_id, store_id, ${column}) VALUES ($1, $2, $3)
       ON CONFLICT (store_id, ${column}) DO NOTHING`,
      [organizationId, storeId, value],
    );
  }
  await tx.query(
    `UPDATE ${table} SET is_default = (${column} = $2) WHERE store_id = $1 AND is_default <> (${column} = $2)`,
    [storeId, defaultValue],
  );
}

export async function syncStoreSets(
  tx: Queryable,
  organizationId: string,
  storeId: string,
  locales: string[] | undefined,
  defaultLocale: string,
  currencies: string[] | undefined,
  defaultCurrency: string,
): Promise<void> {
  await syncStoreSet(
    tx,
    { table: 'store_locale', column: 'locale' },
    organizationId,
    storeId,
    locales,
    defaultLocale,
  );
  await syncStoreSet(
    tx,
    { table: 'store_currency', column: 'currency' },
    organizationId,
    storeId,
    currencies,
    defaultCurrency,
  );
}

// ---------------------------------------------------------------------------------------------------- stores

/** Whitelisted ORDER BY per contract `sort` value (never interpolate user input into SQL). */
const STORE_ORDER_BY: Record<StoreSortField, string> = {
  code: 'code',
  name: 'name',
  status: 'status',
  created_at: 'created_at',
};

export async function listStores(
  client: ScopedClient,
  q: StoreListQuery = {},
): Promise<Page<Store>> {
  const page = Math.max(1, q.page ?? 1);
  const limit = Math.min(100, Math.max(1, q.limit ?? 20));
  // Contract defaults: sort created_at, order desc; `order` only applies together with `sort`.
  const sort: StoreSortField = q.sort ?? 'created_at';
  const order: SortOrder = q.sort ? (q.order ?? 'desc') : 'desc';
  const orderBy = `${STORE_ORDER_BY[sort]} ${order === 'asc' ? 'ASC' : 'DESC'}, id`;
  return client.transaction(async (tx) => {
    const total = await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM store');
    const rows = await tx.query<StoreRow>(
      `${STORE_SELECT} ORDER BY ${orderBy} LIMIT $1 OFFSET $2`,
      [limit, (page - 1) * limit],
    );
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
    const created = inserted.rows[0]!;

    await syncStoreSets(
      tx,
      organizationId,
      created.id,
      input.locales,
      created.default_locale,
      input.currencies,
      created.default_currency,
    );

    const row = await loadStore(tx, created.id); // with the enabled sets just written
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
  opts: { registrar?: StoreRegistrar } = {},
): Promise<Store> {
  validateStoreInput(patch, 'update');
  const organizationId = organizationOf(client);

  return client.transaction(async (tx) => {
    const before = await lockStore(tx, id);
    // A move to `active` is activation (#413): same prerequisites as `activateStore`, same 409. Checked on the
    // rows as they are BEFORE this patch; an archived store cannot be revived through a status patch either.
    if (patch.status === 'active' && before.status !== 'active') {
      await refuseUnlessReady(tx, before, opts.registrar);
    }
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const col of STORE_COLUMNS) {
      const value = patch[col as keyof StoreInput];
      if (value === undefined) continue;
      params.push(col === 'theme' || col === 'settings' ? JSON.stringify(value) : value);
      sets.push(`${col} = $${params.length}`);
    }
    if (sets.length) {
      await tx
        .query(`UPDATE store SET ${sets.join(', ')} WHERE id = $1`, params)
        .catch((e) => mapPgError(e, `store "${patch.code ?? before.code}"`));
    }
    // The default kept in each set is the one given in this request, or the current one.
    await syncStoreSets(
      tx,
      organizationId,
      id,
      patch.locales,
      patch.default_locale ?? before.default_locale,
      patch.currencies,
      patch.default_currency ?? before.default_currency,
    );
    const after = await loadStore(tx, id);

    const beforeStore = toStore(before);
    const afterStore = toStore(after);
    // The two sets are compared as sets: a new default only reorders them (default first).
    const comparable = (k: keyof Store, s: Store): string =>
      JSON.stringify(k === 'currencies' || k === 'locales' ? [...(s[k] ?? [])].sort() : s[k]);
    const changed = (Object.keys(afterStore) as (keyof Store)[]).filter(
      (k) => k !== 'updated_at' && comparable(k, beforeStore) !== comparable(k, afterStore),
    );
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

/**
 * Activation gate shared by `activateStore` and `updateStore` (#413, #417): archived stores stay archived
 * (409 `details.status`), anything missing is listed (409 `details.missing`). Without a registrar the
 * OpenFGA object cannot be confirmed, so it counts as missing — never assumed present.
 */
export async function refuseUnlessReady(
  tx: Queryable,
  store: StoreRow,
  registrar: StoreRegistrar | undefined,
): Promise<void> {
  if (store.status === 'archived') {
    throw conflict('an archived store cannot be activated', { status: 'archived' });
  }
  const { missing } = await storeReadiness(tx, store, registrar ?? UNKNOWN_REGISTRAR);
  if (missing.length) throw conflict('store is not ready to activate', { missing });
}

/** No registrar given: the OpenFGA object is unknown, so it is reported missing and never written. */
const UNKNOWN_REGISTRAR: StoreRegistrar = {
  ensureStoreObject: () => Promise.resolve(),
  hasStoreObject: () => Promise.resolve(false),
};

/**
 * `store.updated` for a change to something the store owns besides its own row (domains, sales channels, API
 * keys, a locale or currency added on its own): the payload names the area in `changed_fields` and carries no
 * key material, no hostname and no other value. Every registry mutation writes the outbox in its transaction —
 * audit alone is not enough (manager ruling, #308 review).
 */
export function storeUpdatedEvent(
  store: StoreRow,
  organizationId: string,
  actor: Actor,
  changedFields: string[],
): Promise<EventEnvelope> {
  return buildEvent({
    topic: 'store.updated',
    organizationId,
    storeId: store.id,
    aggregateType: 'store',
    aggregateId: store.id,
    actor: eventActor(actor),
    payload: {
      store_id: store.id,
      code: store.code,
      status: store.status,
      changed_fields: changedFields,
    },
  });
}

// --------------------------------------------------------------------------------------------------- domains

export interface DomainRow {
  id: string;
  hostname: string;
  is_primary: boolean;
  verified_at: Date | null;
}

export const toDomain = (r: DomainRow): Domain => ({
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
    const store = await loadStore(tx, storeId);
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
    await withEvents(tx, [await storeUpdatedEvent(store, organizationId, actor, ['domains'])]);
    return domain;
  });
}

/**
 * Moves the primary flag to this domain (Admin API 0.4.7 `updateDomain`, #279): exactly one primary per store,
 * moved in one transaction. `is_primary: false` on the current primary is a 409 — a store always has one;
 * a request that changes nothing (already primary, or `false` on a non-primary) answers the row and writes
 * nothing. Emits `store.updated` (`changed_fields: ['domains']`, no hostname) with the move.
 */
export async function updateDomain(
  client: ScopedClient,
  storeId: string,
  domainId: string,
  input: DomainUpdate,
  actor: Actor = SYSTEM_ACTOR,
): Promise<Domain> {
  if (typeof input?.is_primary !== 'boolean')
    throw validationError('invalid domain input', { is_primary: 'required boolean' });
  const organizationId = organizationOf(client);

  return client.transaction(async (tx) => {
    const store = await loadStore(tx, storeId);
    // The store's domain rows are locked in one order, so two concurrent moves queue instead of racing the
    // one-primary index.
    const domains = await tx.query<DomainRow>(
      `SELECT id, hostname, is_primary, verified_at FROM store_domain WHERE store_id = $1
       ORDER BY id FOR UPDATE`,
      [storeId],
    );
    const before = domains.rows.find((d) => d.id === domainId);
    if (!before) throw notFound('domain', domainId);
    if (before.is_primary === input.is_primary) return toDomain(before);
    if (!input.is_primary) {
      throw conflict(
        'a store always has one primary domain: move it by setting another domain primary',
        { domain_id: domainId },
      );
    }
    // Clear, then set: `store_domain_one_primary` allows one primary row per store at any moment.
    await tx.query(
      'UPDATE store_domain SET is_primary = false WHERE store_id = $1 AND is_primary',
      [storeId],
    );
    const r = await tx.query<DomainRow>(
      `UPDATE store_domain SET is_primary = true WHERE id = $1
       RETURNING id, hostname, is_primary, verified_at`,
      [domainId],
    );
    const domain = toDomain(r.rows[0]!);
    await writeAudit(tx, {
      organizationId,
      storeId,
      actor,
      action: 'store_domain.update',
      entityType: 'store_domain',
      entityId: domainId,
      before: toDomain(before),
      after: domain,
    });
    await withEvents(tx, [await storeUpdatedEvent(store, organizationId, actor, ['domains'])]);
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

/**
 * Adds a locale; `isDefault` also changes `store.default_locale`. Emits `store.updated` either way (`['locales']`
 * for a plain addition; nothing when the locale was already enabled).
 */
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
      const store = await lockStore(tx, storeId);
      // Add-only: the current set plus the new locale; currencies untouched.
      await syncStoreSets(
        tx,
        store.organization_id,
        storeId,
        [...(store.locales ?? []), locale],
        store.default_locale,
        undefined,
        store.default_currency,
      );
      await writeAudit(tx, {
        organizationId: store.organization_id,
        storeId,
        actor,
        action: 'store_locale.create',
        entityType: 'store',
        entityId: storeId,
        after: { locale },
      });
      // A locale that was already enabled changes nothing: no event.
      if (!(store.locales ?? []).includes(locale)) {
        await withEvents(tx, [
          await storeUpdatedEvent(store, store.organization_id, actor, ['locales']),
        ]);
      }
    });
  }
  return listLocales(client, storeId);
}

/**
 * Adds a currency; `isDefault` also changes `store.default_currency`. Emits `store.updated` either way
 * (`['currencies']` for a plain addition; nothing when the currency was already enabled).
 */
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
      const store = await lockStore(tx, storeId);
      // Add-only: the current set plus the new currency; locales untouched.
      await syncStoreSets(
        tx,
        store.organization_id,
        storeId,
        undefined,
        store.default_locale,
        [...(store.currencies ?? []), currency],
        store.default_currency,
      );
      await writeAudit(tx, {
        organizationId: store.organization_id,
        storeId,
        actor,
        action: 'store_currency.create',
        entityType: 'store',
        entityId: storeId,
        after: { currency },
      });
      // A currency that was already enabled changes nothing: no event.
      if (!(store.currencies ?? []).includes(currency)) {
        await withEvents(tx, [
          await storeUpdatedEvent(store, store.organization_id, actor, ['currencies']),
        ]);
      }
    });
  }
  return listCurrencies(client, storeId);
}

// ---------------------------------------------------------------------------------------------- sales channels

export interface ChannelRow {
  id: string;
  code: string;
  name: string;
  type: SalesChannel['type'];
  is_active: boolean;
}

export const toChannel = (r: ChannelRow): SalesChannel => ({
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
    const store = await loadStore(tx, storeId);
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
    await withEvents(tx, [
      await storeUpdatedEvent(store, organizationId, actor, ['sales_channels']),
    ]);
    return channel;
  });
}

// --------------------------------------------------------------------------------------------------- api keys

export interface ApiKeyRow {
  id: string;
  name: string;
  type: ApiKey['type'];
  key_prefix: string;
  sales_channel_id: string | null;
  revoked_at: Date | null;
  created_at: Date;
}

export const toApiKey = (r: ApiKeyRow): ApiKey => ({
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
    await withEvents(tx, [await storeUpdatedEvent(store, organizationId, actor, ['api_keys'])]);
    return { ...key, key: plain };
  });
}

/**
 * Revokes a key (Admin API 0.4.7 `revokeApiKey`, #279). Idempotent on an already revoked key. The store's last
 * publishable key with `revoked_at IS NULL` is refused with 409 `last_live_key` — the storefront would lose
 * its only credential; secret keys are not counted and never refused. Emits `store.updated`
 * (`changed_fields: ['api_keys']`, no key material) in the same transaction.
 */
export async function revokeApiKey(
  client: ScopedClient,
  storeId: string,
  keyId: string,
  actor: Actor = SYSTEM_ACTOR,
): Promise<ApiKey> {
  const organizationId = organizationOf(client);
  return client.transaction(async (tx) => {
    const store = await loadStore(tx, storeId);
    // Every key row of the store is locked in one order: two concurrent revokes of the last two live
    // publishable keys queue here, and the second one sees the first one's result.
    const keys = await tx.query<ApiKeyRow>(
      `SELECT id, name, type, key_prefix, sales_channel_id, revoked_at, created_at
       FROM store_api_key WHERE store_id = $1 ORDER BY id FOR UPDATE`,
      [storeId],
    );
    const before = keys.rows.find((k) => k.id === keyId);
    if (!before) throw notFound('api key', keyId);
    // Idempotent: same row, same revoked_at — nothing written, nothing emitted.
    if (before.revoked_at) return toApiKey(before);
    const otherLiveKey = keys.rows.some(
      (k) => k.id !== keyId && k.type === 'publishable' && !k.revoked_at,
    );
    if (before.type === 'publishable' && !otherLiveKey) {
      throw new AppError(
        'last_live_key',
        "the store's last live publishable key cannot be revoked",
        { key_id: keyId },
      );
    }
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
      before: toApiKey(before),
      after: key,
    });
    await withEvents(tx, [await storeUpdatedEvent(store, organizationId, actor, ['api_keys'])]);
    return key;
  });
}

export type { EventEnvelope };

// ------------------------------------------------------------------------------ organization-level reads

/** Warehouses of the organization (window 11 owns mutations from Phase 3). */
export async function listWarehouses(client: ScopedClient): Promise<Warehouse[]> {
  const r = await client.query<Warehouse>(
    'SELECT id, code, name, country, is_active, priority FROM warehouse ORDER BY priority, code',
  );
  return r.rows;
}

/** Legal entities of the organization (accounting companies; window 15 fills odoo_company_id). */
export async function listLegalEntities(client: ScopedClient): Promise<LegalEntity[]> {
  const r = await client.query<LegalEntity>(
    'SELECT id, code, name, country, currency, vat_number FROM legal_entity ORDER BY code',
  );
  return r.rows;
}
