// Store onboarding (#413, Admin API 0.4.11 / CONTRACT CHANGE #417): one transaction creates everything a brand
// needs to exist — legal entity (inline or existing), the store in `draft`, its enabled sets, the primary
// domain, the `web` sales channel and one publishable key — with the audit row and the `store.created` outbox
// row; then, OUTSIDE the transaction, the store's OpenFGA object is registered through the `StoreRegistrar`
// seam (window 2's `ensureStoreObject`, #415). Activation is the separate `activateStore` step, gated by
// `storeReadiness` (shared with `updateStore`, see service.ts `refuseUnlessReady`).
//
// Idempotent by `code`: a second call with the same input answers the same store with `publishable_key: null`
// (the key is shown once) and re-runs the OpenFGA registration — which is how a registration that failed after
// the commit is repaired; the same code with a different input is a 409 naming what differs. Nothing is
// written on the repeat path.
import type { Queryable, ScopedClient } from '@platform/db';
import { SYSTEM_ACTOR, writeAudit, type Actor } from '../../lib/audit';
import { conflict, mapPgError, validationError } from '../../lib/errors';
import { buildEvent, eventActor, withEvents } from '../../outbox';
import {
  CODE,
  COUNTRY,
  CURRENCY,
  generatePlainKey,
  loadStore,
  lockStore,
  organizationOf,
  refuseUnlessReady,
  requireOrganizationScope,
  sha256,
  syncStoreSets,
  toApiKey,
  toChannel,
  toDomain,
  toStore,
  type ApiKeyRow,
  type ChannelRow,
  type DomainRow,
} from './service';
import { validateStoreSettings } from './settings-schema';
import type {
  LegalEntity,
  LegalEntityInput,
  Store,
  StoreOnboarded,
  StoreOnboardingInput,
  StoreRegistrar,
  StoreRow,
} from './types';

/** Conventions the server owns (never client input). */
export const onboardingConventions = (code: string) => ({
  content_space_id: code,
  search_index: `${code}_products`,
  sales_channel: { code: 'web', type: 'web' as const },
  publishable_key_name: 'storefront',
});

const HOSTNAME = /^[a-z0-9.-]+$/;

interface Normalised {
  legal_entity: string; // `id:<uuid>` or `inline:<code>|<name>|<country>|<currency>|<vat>`
  name: string;
  default_currency: string;
  default_locale: string;
  default_country: string;
  timezone: string;
  currencies: string[];
  locales: string[];
  hostname: string;
  theme: string;
  settings: string;
}

function validateOnboardingInput(input: StoreOnboardingInput): void {
  const problems: Record<string, string> = {};
  const hasId = input.legal_entity_id !== undefined && input.legal_entity_id !== null;
  const hasInline = input.legal_entity !== undefined && input.legal_entity !== null;
  if (hasId === hasInline)
    problems.legal_entity = 'exactly one of legal_entity_id and legal_entity';
  if (hasInline) {
    const le = input.legal_entity as LegalEntityInput;
    if (!le.code || !CODE.test(le.code)) problems['legal_entity.code'] = 'lowercase kebab-case';
    if (!le.name) problems['legal_entity.name'] = 'required';
    if (!le.country || !COUNTRY.test(le.country))
      problems['legal_entity.country'] = 'ISO-3166-1 alpha-2';
    if (!le.currency || !CURRENCY.test(le.currency))
      problems['legal_entity.currency'] = 'ISO-4217 upper-case';
    if (le.vat_number !== undefined && le.vat_number !== null && typeof le.vat_number !== 'string')
      problems['legal_entity.vat_number'] = 'string or null';
  }
  if (!input.code || !CODE.test(input.code)) problems.code = 'lowercase kebab-case';
  if (!input.name) problems.name = 'required';
  if (!input.default_currency || !CURRENCY.test(input.default_currency))
    problems.default_currency = 'ISO-4217 upper-case';
  if (!input.default_locale) problems.default_locale = 'required';
  if (!input.default_country || !COUNTRY.test(input.default_country))
    problems.default_country = 'ISO-3166-1 alpha-2';
  for (const c of input.currencies ?? []) if (!CURRENCY.test(c)) problems.currencies = 'ISO-4217';
  for (const l of input.locales ?? []) if (!l) problems.locales = 'non-empty tags';
  const hostname = input.domain?.hostname?.trim().toLowerCase();
  if (!hostname || !HOSTNAME.test(hostname)) problems['domain.hostname'] = 'lowercase hostname';
  if (Object.keys(problems).length) throw validationError('invalid onboarding input', problems);
  validateStoreSettings(input.settings); // 422, after the 400s
}

const sortedSet = (def: string, rest: string[] | undefined): string[] =>
  [...new Set([def, ...(rest ?? [])])].sort();

function normalise(input: StoreOnboardingInput): Normalised {
  const le = input.legal_entity;
  return {
    legal_entity: input.legal_entity_id
      ? `id:${input.legal_entity_id}`
      : `inline:${le!.code}|${le!.name}|${le!.country}|${le!.currency}|${le!.vat_number ?? ''}`,
    name: input.name,
    default_currency: input.default_currency,
    default_locale: input.default_locale,
    default_country: input.default_country,
    timezone: input.timezone ?? 'UTC',
    currencies: sortedSet(input.default_currency, input.currencies),
    locales: sortedSet(input.default_locale, input.locales),
    hostname: input.domain.hostname.trim().toLowerCase(),
    theme: JSON.stringify(input.theme ?? {}),
    settings: JSON.stringify(input.settings ?? {}),
  };
}

type LegalEntityRow = LegalEntity;

async function loadLegalEntity(tx: Queryable, id: string): Promise<LegalEntityRow | null> {
  const r = await tx.query<LegalEntityRow>(
    'SELECT id, code, name, country, currency, vat_number FROM legal_entity WHERE id = $1',
    [id],
  );
  return r.rows[0] ?? null;
}

/** What the existing store looks like in the input's terms — for the idempotency comparison. */
async function normalisedState(
  tx: Queryable,
  row: StoreRow,
  le: LegalEntityRow,
): Promise<Normalised> {
  const dom = await tx.query<{ hostname: string }>(
    'SELECT hostname FROM store_domain WHERE store_id = $1 AND is_primary',
    [row.id],
  );
  const store = toStore(row);
  return {
    legal_entity: `id:${le.id}`,
    name: store.name,
    default_currency: store.default_currency,
    default_locale: store.default_locale,
    default_country: store.default_country,
    timezone: store.timezone,
    currencies: [...(store.currencies ?? [])].sort(),
    locales: [...(store.locales ?? [])].sort(),
    hostname: dom.rows[0]?.hostname ?? '',
    theme: JSON.stringify(store.theme ?? {}),
    settings: JSON.stringify(store.settings ?? {}),
  };
}

function differences(a: Normalised, b: Normalised): string[] {
  return (Object.keys(a) as (keyof Normalised)[]).filter(
    (k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]),
  );
}

export interface OnboardStoreResult {
  result: StoreOnboarded;
  /** false = the repeat of an onboarding already done (the route answers 200 instead of 201). */
  created: boolean;
}

/**
 * The workflow. Organization scope only (`owner organization:hq` by contract). See the file header.
 */
export async function onboardStore(
  client: ScopedClient,
  input: StoreOnboardingInput,
  registrar: StoreRegistrar,
  actor: Actor = SYSTEM_ACTOR,
): Promise<OnboardStoreResult> {
  requireOrganizationScope(client, 'onboardStore');
  validateOnboardingInput(input);
  const organizationId = organizationOf(client);
  const wanted = normalise(input);
  const conventions = onboardingConventions(input.code);

  const outcome = await client.transaction(async (tx): Promise<OnboardStoreResult> => {
    // ---- the repeat path: a store with this code exists → same input = the same answer, nothing written
    const existing = await tx.query<{ id: string }>('SELECT id FROM store WHERE code = $1', [
      input.code,
    ]);
    if (existing.rows[0]) {
      const row = await loadStore(tx, existing.rows[0].id);
      const le = await loadLegalEntity(tx, row.legal_entity_id);
      const state = le ? await normalisedState(tx, row, le) : null;
      // An inline legal entity on the repeat is compared by its stored row, not by id.
      const comparable: Normalised | null =
        state && le && input.legal_entity
          ? {
              ...state,
              legal_entity: `inline:${le.code}|${le.name}|${le.country}|${le.currency}|${le.vat_number ?? ''}`,
            }
          : state;
      const differs = comparable ? differences(wanted, comparable) : ['legal_entity'];
      if (differs.length) {
        throw conflict(`store "${input.code}" already exists with a different definition`, {
          field: 'code',
          differs: differs.sort(),
        });
      }
      // one statement at a time on the transaction client (pg queues concurrent queries; guards.test.ts)
      const domain = await tx.query<DomainRow>(
        'SELECT id, hostname, is_primary, verified_at FROM store_domain WHERE store_id = $1 AND is_primary',
        [row.id],
      );
      const channel = await tx.query<ChannelRow>(
        `SELECT id, code, name, type, is_active FROM sales_channel WHERE store_id = $1 AND code = $2`,
        [row.id, conventions.sales_channel.code],
      );
      return {
        created: false,
        result: {
          store: toStore(row),
          legal_entity: le!,
          domain: toDomain(domain.rows[0]!),
          sales_channel: toChannel(channel.rows[0]!),
          publishable_key: null,
        },
      };
    }

    // ---- 1. legal entity
    let legalEntity: LegalEntityRow;
    if (input.legal_entity_id) {
      const found = await loadLegalEntity(tx, input.legal_entity_id);
      if (!found) throw validationError('unknown legal entity', { legal_entity_id: 'unknown' });
      legalEntity = found;
    } else {
      const le = input.legal_entity!;
      const r = await tx
        .query<LegalEntityRow>(
          `INSERT INTO legal_entity (organization_id, code, name, country, currency, vat_number)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, code, name, country, currency, vat_number`,
          [organizationId, le.code, le.name, le.country, le.currency, le.vat_number ?? null],
        )
        .catch((e) => mapPgError(e, `legal entity "${le.code}"`));
      legalEntity = r.rows[0]!;
    }

    // ---- 2. the store, draft, with the conventions
    const inserted = await tx
      .query<StoreRow>(
        `INSERT INTO store (organization_id, legal_entity_id, code, name, status, default_currency, default_locale,
                            default_country, timezone, content_space_id, search_index, theme, settings)
         VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [
          organizationId,
          legalEntity.id,
          input.code,
          input.name,
          input.default_currency,
          input.default_locale,
          input.default_country,
          wanted.timezone,
          conventions.content_space_id,
          conventions.search_index,
          JSON.stringify(input.theme ?? {}),
          JSON.stringify(input.settings ?? {}),
        ],
      )
      .catch((e) => mapPgError(e, `store "${input.code}"`));
    const storeId = inserted.rows[0]!.id;

    // ---- 3. enabled sets (defaults first)
    await syncStoreSets(
      tx,
      organizationId,
      storeId,
      input.locales ?? [],
      input.default_locale,
      input.currencies ?? [],
      input.default_currency,
    );

    // ---- 4. the primary domain
    const dom = await tx
      .query<DomainRow>(
        `INSERT INTO store_domain (organization_id, store_id, hostname, is_primary) VALUES ($1, $2, $3, true)
         RETURNING id, hostname, is_primary, verified_at`,
        [organizationId, storeId, wanted.hostname],
      )
      .catch((e: unknown) => {
        // #417 decision 1: a hostname another store has is a 409 naming the field (review of #424)
        if ((e as { code?: string }).code === '23505') {
          throw conflict(`hostname "${wanted.hostname}" is already in use`, {
            field: 'domain.hostname',
          });
        }
        return mapPgError(e, `domain "${wanted.hostname}"`);
      });
    const domain = toDomain(dom.rows[0]!);

    // ---- 5. the web sales channel
    const ch = await tx.query<ChannelRow>(
      `INSERT INTO sales_channel (organization_id, store_id, code, name, type) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, code, name, type, is_active`,
      [
        organizationId,
        storeId,
        conventions.sales_channel.code,
        input.name,
        conventions.sales_channel.type,
      ],
    );
    const channel = toChannel(ch.rows[0]!);

    // ---- 6. one publishable key, bound to the channel; the plain key is returned once and never stored
    const plain = generatePlainKey('publishable', input.code);
    const k = await tx.query<ApiKeyRow>(
      `INSERT INTO store_api_key (organization_id, store_id, name, type, key_prefix, key_hash, sales_channel_id)
       VALUES ($1, $2, $3, 'publishable', $4, $5, $6)
       RETURNING id, name, type, key_prefix, sales_channel_id, revoked_at, created_at`,
      [
        organizationId,
        storeId,
        conventions.publishable_key_name,
        plain.slice(0, 8),
        sha256(plain),
        channel.id,
      ],
    );
    const key = toApiKey(k.rows[0]!);

    // ---- 7. audit + outbox, same transaction
    const row = await loadStore(tx, storeId);
    const store: Store = toStore(row);
    await writeAudit(tx, {
      organizationId,
      storeId,
      actor,
      action: 'store.onboard',
      entityType: 'store',
      entityId: storeId,
      after: {
        store,
        legal_entity: legalEntity,
        domain,
        sales_channel: channel,
        publishable_key: key, // id, name, prefix — never the plain key or its hash
      },
    });
    await withEvents(tx, [
      await buildEvent({
        topic: 'store.created',
        organizationId,
        storeId,
        aggregateType: 'store',
        aggregateId: storeId,
        actor: eventActor(actor),
        payload: {
          store_id: storeId,
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
    return {
      created: true,
      result: {
        store,
        legal_entity: legalEntity,
        domain,
        sales_channel: channel,
        publishable_key: { ...key, key: plain },
      },
    };
  });

  // ---- outside the transaction: the OpenFGA object (idempotent; repeated on every call, so a registration
  // that failed after the commit is repaired by calling again)
  await registrar.ensureStoreObject(outcome.result.store.id);
  return outcome;
}

/**
 * `draft` | `paused` → `active` once every prerequisite is present (409 `details.missing` otherwise; archived →
 * 409 `details.status`). An active store is a no-op 200: no audit, no event. Organization scope only.
 */
export async function activateStore(
  client: ScopedClient,
  storeId: string,
  registrar: StoreRegistrar,
  actor: Actor = SYSTEM_ACTOR,
): Promise<Store> {
  requireOrganizationScope(client, 'activateStore');
  const organizationId = organizationOf(client);
  return client.transaction(async (tx) => {
    const before = await lockStore(tx, storeId);
    if (before.status === 'active') return toStore(before);
    await refuseUnlessReady(tx, before, registrar);
    await tx.query(`UPDATE store SET status = 'active' WHERE id = $1`, [storeId]);
    const after = await loadStore(tx, storeId);
    const beforeStore = toStore(before);
    const afterStore = toStore(after);
    await writeAudit(tx, {
      organizationId,
      storeId,
      actor,
      action: 'store.activate',
      entityType: 'store',
      entityId: storeId,
      before: beforeStore,
      after: afterStore,
    });
    await withEvents(tx, [
      await buildEvent({
        topic: 'store.updated',
        organizationId,
        storeId,
        aggregateType: 'store',
        aggregateId: storeId,
        actor: eventActor(actor),
        payload: {
          store_id: storeId,
          code: after.code,
          status: after.status,
          changed_fields: ['status'],
        },
      }),
    ]);
    return afterStore;
  });
}
