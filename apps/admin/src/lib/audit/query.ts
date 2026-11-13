/**
 * The HQ audit view's filters, parsed once and used by both the page and its CSV export.
 *
 * The export must answer the same question as the screen — "export the visible columns" is a lie
 * if the two parse `?from=` differently — so the parsing lives here and both call it.
 *
 * Pure: no `next/*`, no I/O.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `components/parameters/Limit` caps at 100, and `listAuditLog` enforces it server-side too. */
export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 50;

/**
 * The entity types the core writes audit rows for today (54 `writeAudit` call sites).
 *
 * A filter the API would accept but nothing ever wrote is a dead end for the reader, so the select
 * offers exactly these. `order` is deliberately absent: nothing writes an order row yet.
 */
export const AUDITED_ENTITY_TYPES = [
  'campaign',
  'cart',
  'cart_recovery',
  'customer',
  'customer_export',
  'cycle_count',
  'payment',
  'price_list',
  'product',
  'product_category',
  'product_feed',
  'product_media',
  'product_variant',
  'promotion',
  'sales_channel',
  'segment',
  'shipping_option',
  'stock_movement',
  'store',
  'store_api_key',
  'store_domain',
  'tax_rate',
] as const;

export interface AuditQuery {
  page: number;
  limit: number;
  order: 'asc' | 'desc';
  storeId: string | null;
  entityType: string | null;
  actorId: string | null;
  /** Calendar days as typed in the form (`YYYY-MM-DD`), or null. */
  from: string | null;
  to: string | null;
}

export interface ReadableParams {
  get: (name: string) => string | null;
}

function positiveInt(raw: string | null, fallback: number, max?: number): number {
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return max !== undefined && value > max ? max : value;
}

/** An id that is not a uuid is dropped rather than sent: the API would answer 400 and show nothing. */
function uuidOrNull(raw: string | null): string | null {
  return raw !== null && UUID.test(raw) ? raw : null;
}

function dayOrNull(raw: string | null): string | null {
  return raw !== null && DATE.test(raw) ? raw : null;
}

export function parseAuditQuery(params: ReadableParams): AuditQuery {
  const order = params.get('order');
  const entityType = params.get('entity_type');
  return {
    page: positiveInt(params.get('page'), 1),
    limit: positiveInt(params.get('limit'), DEFAULT_LIMIT, MAX_LIMIT),
    order: order === 'asc' ? 'asc' : 'desc',
    storeId: uuidOrNull(params.get('store_id')),
    entityType:
      entityType !== null && (AUDITED_ENTITY_TYPES as readonly string[]).includes(entityType)
        ? entityType
        : null,
    actorId: uuidOrNull(params.get('actor_id')),
    from: dayOrNull(params.get('from')),
    to: dayOrNull(params.get('to')),
  };
}

/**
 * A calendar day becomes the instant the reader means: `from` is the start of that day and `to`
 * the **end** of it. Sending the bare date for `to` would silently exclude everything that
 * happened on the day the reader asked for — the filter would look like it worked.
 *
 * UTC, because `created_at` is stored and rendered in UTC everywhere in this app.
 */
export function dayStart(day: string): string {
  return `${day}T00:00:00.000Z`;
}

export function dayEnd(day: string): string {
  return `${day}T23:59:59.999Z`;
}

/** Exactly the parameters `listAuditLog` defines; nothing else is sent. */
export function toListQuery(query: AuditQuery): Record<string, string | number> {
  const contract: Record<string, string | number> = {
    page: query.page,
    limit: query.limit,
    sort: 'created_at',
    order: query.order,
  };
  if (query.storeId !== null) contract['store_id'] = query.storeId;
  if (query.entityType !== null) contract['entity_type'] = query.entityType;
  if (query.actorId !== null) contract['actor_id'] = query.actorId;
  if (query.from !== null) contract['from'] = dayStart(query.from);
  if (query.to !== null) contract['to'] = dayEnd(query.to);
  return contract;
}

/** Back to a query string for a link, omitting defaults. */
export function toSearch(query: AuditQuery): string {
  const params = new URLSearchParams();
  if (query.storeId !== null) params.set('store_id', query.storeId);
  if (query.entityType !== null) params.set('entity_type', query.entityType);
  if (query.actorId !== null) params.set('actor_id', query.actorId);
  if (query.from !== null) params.set('from', query.from);
  if (query.to !== null) params.set('to', query.to);
  if (query.order !== 'desc') params.set('order', query.order);
  if (query.page > 1) params.set('page', String(query.page));
  if (query.limit !== DEFAULT_LIMIT) params.set('limit', String(query.limit));
  return params.toString();
}

/** True when at least one filter is set — used to offer "Clear filters" honestly. */
export function isFiltered(query: AuditQuery): boolean {
  return (
    query.storeId !== null ||
    query.entityType !== null ||
    query.actorId !== null ||
    query.from !== null ||
    query.to !== null
  );
}
