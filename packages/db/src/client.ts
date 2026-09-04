import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

/** Who is acting and on which tenant. Every request resolves one of these (packages/auth-sdk) before touching data. */
export interface TenantContext {
  organizationId: string;
  /** One or more store ids the caller may act on. Empty = no store rows visible. */
  storeIds: string[];
  /** staff_user.id / customer.id; null for system jobs. */
  actorId?: string | null;
}

export interface OrganizationContext {
  organizationId: string;
  actorId?: string | null;
}

export type Queryable = {
  query<R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<R>>;
};

export interface ScopedClient {
  /** Runs one statement in its own transaction with the tenant context applied. */
  query<R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<R>>;
  /** Runs `fn` inside one transaction with the tenant context applied; commits on return, rolls back on throw. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  readonly context: Readonly<TenantContext | OrganizationContext>;
  readonly scope: 'store' | 'organization';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, what: string): void {
  if (!UUID.test(value)) throw new Error(`${what} must be a uuid, got "${value}"`);
}

async function applyContext(
  client: PoolClient,
  scope: 'store' | 'organization',
  ctx: TenantContext | OrganizationContext,
): Promise<void> {
  assertUuid(ctx.organizationId, 'organizationId');
  const storeIds = scope === 'store' ? (ctx as TenantContext).storeIds : [];
  for (const id of storeIds) assertUuid(id, 'storeId');
  if (ctx.actorId) assertUuid(ctx.actorId, 'actorId');
  // set_config(..., true) = transaction-local: the context disappears at COMMIT/ROLLBACK, so a pooled
  // connection can never leak one tenant's context into the next request.
  await client.query(
    `SELECT set_config('app.organization_id', $1, true),
            set_config('app.scope', $2, true),
            set_config('app.store_ids', $3, true),
            set_config('app.actor_id', $4, true)`,
    [ctx.organizationId, scope, storeIds.join(','), ctx.actorId ?? ''],
  );
}

function build(pool: Pool, scope: 'store' | 'organization', ctx: TenantContext | OrganizationContext): ScopedClient {
  const transaction = async <T>(fn: (tx: Queryable) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await applyContext(client, scope, ctx);
      const out = await fn({ query: (text, params) => client.query(text, params as unknown[] | undefined) });
      await client.query('COMMIT');
      return out;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* connection already broken */
      }
      throw err;
    } finally {
      client.release();
    }
  };
  return {
    scope,
    context: Object.freeze({ ...ctx }),
    transaction,
    query: (text, params) => transaction((tx) => tx.query(text, params)),
  };
}

/** Store scope: rows of the given store(s) inside the organization. This is what every Store/Admin API request uses. */
export function createTenantClient(pool: Pool, ctx: TenantContext): ScopedClient {
  if (ctx.storeIds.length === 0) throw new Error('createTenantClient requires at least one storeId');
  return build(pool, 'store', ctx);
}

/** Organization (HQ) scope: every store of the organization. Only for callers that passed an organization-level permission check. */
export function createOrganizationClient(pool: Pool, ctx: OrganizationContext): ScopedClient {
  return build(pool, 'organization', ctx);
}
