/**
 * What an audit row is allowed to SHOW.
 *
 * `listAuditLog` returns `before` and `after` as raw JSON bodies — the contract types them
 * `additionalProperties: true`, and `packages/auth-sdk/src/audit/read.ts` selects the columns
 * verbatim. Today the core is disciplined about what it puts there (`customer.update` writes
 * `{status, customer_group_id, changed_fields}` with the comment "never a name, a phone or an
 * email"; `payment.capture` writes "ids and amounts only"; `store_api_key.create` writes the key
 * row "never the plain key or its hash"). The admin cannot *depend* on that: one new `writeAudit`
 * call anywhere in the core changes what this panel renders, without touching this app.
 *
 * So the rule is an allow-list and it fails closed:
 *
 * 1. a value is rendered only for an `(entity_type, field)` pair named in `SAFE_VALUE_FIELDS`;
 * 2. a field name matching `NEVER_SHOW` is redacted even if it is on the allow-list, so extending
 *    the list carelessly still cannot print a token or an email;
 * 3. a value that is not a string, number, boolean or null is redacted — a nested object is
 *    exactly where an unreviewed blob would hide;
 * 4. an entity type with no entry shows field NAMES only.
 *
 * Redacted means the reader still learns **that the field changed** — which is the point of a
 * history — without the value. `test/audit-redaction.test.ts` is the guard.
 *
 * Pure: no `next/*`, no I/O, no React.
 */

/** The audit row shape this module needs; structurally satisfied by `AdminComponents['AuditEntry']`. */
export interface AuditLike {
  action: string;
  entity_type: string;
  before?: unknown;
  after?: unknown;
}

/**
 * Field names whose VALUES may be rendered, per entity type.
 *
 * Deliberately short. Every pair here was read in the core's `writeAudit` call site that produces
 * it; a field nobody has looked at belongs in the "names only" default, not here.
 */
export const SAFE_VALUE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  product: ['title', 'handle', 'status', 'subtitle'],
  /**
   * `order`, from the four writers #920 added — `checkout/service.ts` (`order.place`),
   * `orders/service.ts` (`transition` → status_change / update / cancel, and `auditOrder` → ship /
   * return), `orders/edits.ts` (the line edits) and `returns/service.ts` (`order.exchange_link`).
   *
   * **`reason` is deliberately NOT here.** It is `order.cancel_reason`: free text somebody typed,
   * which is exactly where a customer's name or a complaint ends up. It stays a field NAME until
   * #922 decides what may be shown. `cart_id` is left out too — a uuid of a thing this screen
   * cannot open adds nothing to a one-line history.
   */
  order: [
    'status',
    'payment_status',
    'fulfillment_status',
    'display_id',
    'total_minor',
    'currency',
    'line_count',
    'payment_provider',
    'line_item_id',
    'from_quantity',
    'to_quantity',
    // Arrays, summarised by `SHAPES` below rather than printed: `lines` is
    // `[{line_item_id, quantity}]` and `refund_ids` is a list of uuids.
    'lines',
    'refund_ids',
    // An exchange's whole content is the pair of ids it links; both are store-scoped, neither is PII.
    'return_id',
    'exchanged_order_id',
  ],
  product_variant: ['sku', 'title', 'inventory_quantity', 'allow_backorder', 'manage_inventory'],
  product_category: ['name', 'handle'],
  promotion: ['code', 'type', 'status', 'starts_at', 'ends_at', 'usage_limit', 'stackable'],
  // The core writes field names and non-personal values only for a customer (`customers/admin.ts`).
  customer: ['status', 'customer_group_id', 'changed_fields', 'requested_at'],
  // `payments/capture.ts` writes "ids and amounts only — no PII". Amounts are MINOR units; the
  // field name says so, and the page they appear on already states the order's currency.
  payment: ['status', 'amount_minor', 'authorized_minor', 'fee_minor', 'partial', 'captured_at'],
  price_list: ['name', 'type', 'status', 'priority'],
  campaign: ['name', 'status', 'type'],
  segment: ['name', 'status'],
  product_feed: ['name', 'status', 'format'],
  // `inventory/service.ts` writes `delta`, not `quantity` — the first version allow-listed a field
  // that is never written, so the one number a reader wants was withheld (#896 review).
  stock_movement: ['reason', 'delta', 'warehouse_id', 'stock_item_id'],
  // `packages/auth-sdk/src/roles/service.ts`. Who was granted what, on which object, is the whole
  // point of these rows; the staff user is a uuid here, so it stays a name.
  role_assignment: ['relation', 'object_type', 'object_id'],
  // `roles/invite.ts` writes the whole API user PLUS `keycloak_subject` and `required_actions`.
  // Only the status is rendered; everything else, the subject included, is withheld by default.
  staff_user: ['status'],
};

/**
 * Field names that are never rendered, whatever the allow-list says.
 *
 * Belt and braces: the allow-list is the rule, this is the thing that keeps a careless addition to
 * it from becoming an incident. Matches anywhere in the name, case-insensitively.
 */
export const NEVER_SHOW =
  /(secret|token|password|credential|api_key|key_hash|hash|psp|card|iban|bic|swift|account_number|routing|email|phone|address|postcode|zip|ip_address|subject|tax_id|vat|dob|birth)/i;

/** Longest rendered value; anything longer is cut rather than wrapped across the row. */
export const MAX_VALUE_LENGTH = 120;

export type ChangeKind = 'shown' | 'redacted';

export interface FieldChange {
  field: string;
  kind: ChangeKind;
  /** Rendered only when `kind` is `shown`. `null` means the field was absent or null. */
  before: string | null;
  after: string | null;
}

/** True when this exact `(entity_type, field)` pair may show its value. */
export function isSafeField(entityType: string, field: string): boolean {
  if (NEVER_SHOW.test(field)) return false;
  return (SAFE_VALUE_FIELDS[entityType] ?? []).includes(field);
}

/**
 * A scalar rendered for a reader, or `null` when the value cannot be shown at all.
 *
 * `null`/`undefined` render as the word "none" — "status: none → active" reads correctly, while an
 * empty cell would be ambiguous between "absent" and "redacted".
 */
export function formatValue(value: unknown): string | null {
  if (value === null || value === undefined) return 'none';
  if (typeof value === 'string') {
    const text = value.replace(/\s+/g, ' ').trim();
    if (text === '') return 'empty';
    return text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH - 1)}…` : text;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // Objects and arrays: exactly where an unreviewed body would hide. Never rendered.
  return null;
}

/**
 * How a reviewed field whose value is NOT a scalar may be summarised.
 *
 * `formatValue` refuses an object or an array, because a nested body is where an unreviewed blob
 * hides — that default stays. A pair in here declares a summary written against the exact shape
 * the core writes, and each one fails closed itself: anything that is not that shape returns
 * `null` and the field is redacted. A renderer may count and add; it may never print free text.
 */
export type ShapeRenderer = (value: unknown) => string | null;

/** `[{ line_item_id, quantity }]` → "2 lines, 3 units". Ids and words are never printed. */
const lineQuantities: ShapeRenderer = (value) => {
  if (!Array.isArray(value) || value.length === 0) return null;
  let units = 0;
  for (const line of value) {
    const quantity = (line as { quantity?: unknown } | null)?.quantity;
    if (typeof quantity !== 'number' || !Number.isFinite(quantity)) return null;
    units += quantity;
  }
  const lines = `${value.length} line${value.length === 1 ? '' : 's'}`;
  return `${lines}, ${units} unit${units === 1 ? '' : 's'}`;
};

/** A list of ids → how many there are. The ids themselves say nothing to a reader here. */
const countOf =
  (noun: string): ShapeRenderer =>
  (value) => {
    if (!Array.isArray(value)) return null;
    if (!value.every((item) => typeof item === 'string')) return null;
    return `${value.length} ${noun}${value.length === 1 ? '' : 's'}`;
  };

export const SHAPES: Readonly<Record<string, Readonly<Record<string, ShapeRenderer>>>> = {
  order: { lines: lineQuantities, refund_ids: countOf('refund') },
};

/** A scalar, or a reviewed non-scalar shape summarised; `null` when neither applies. */
export function formatFieldValue(entityType: string, field: string, value: unknown): string | null {
  const scalar = formatValue(value);
  if (scalar !== null) return scalar;
  return SHAPES[entityType]?.[field]?.(value) ?? null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  } catch {
    return false;
  }
}

/**
 * The fields this entry changed, each either shown or redacted.
 *
 * When `after.changed_fields` is a list of names (the core writes one for `customer.update`), those
 * names are included even though their values were deliberately not written — that list IS the
 * history for that entity, and dropping it would leave the row saying "updated" and nothing else.
 */
export function fieldChanges(entry: AuditLike): FieldChange[] {
  const before = asRecord(entry.before);
  const after = asRecord(entry.after);
  const names = new Set<string>();
  for (const key of Object.keys(before ?? {})) names.add(key);
  for (const key of Object.keys(after ?? {})) names.add(key);

  const declared = after?.['changed_fields'];
  if (Array.isArray(declared)) {
    for (const name of declared) if (typeof name === 'string') names.add(name);
  }
  // `changed_fields` is the core's own summary of the row, not a field of the entity.
  names.delete('changed_fields');

  const changes: FieldChange[] = [];
  for (const field of [...names].sort()) {
    const from = before?.[field];
    const to = after?.[field];
    const declaredOnly = !(before && field in before) && !(after && field in after);
    if (!declaredOnly && same(from, to)) continue;

    // `null` here means "this body does not record that field", which is NOT the same as "the
    // value was null". `order.ship` writes `before: {}`: printing "none → 2 lines" would assert the
    // order had no lines before, which the row does not say. An explicitly null value still
    // renders, as the word "none", through `formatValue`.
    const recorded = (body: Record<string, unknown> | null, value: unknown) =>
      body === null || !(field in body) ? null : formatFieldValue(entry.entity_type, field, value);
    const shownBefore = recorded(before, from);
    const shownAfter = recorded(after, to);
    // Safe when the pair is reviewed AND every value this row actually records could be rendered.
    const couldRender = (body: Record<string, unknown> | null, shown: string | null) =>
      body === null || !(field in body) || shown !== null;
    const safe =
      isSafeField(entry.entity_type, field) &&
      !declaredOnly &&
      couldRender(before, shownBefore) &&
      couldRender(after, shownAfter);

    changes.push(
      safe
        ? { field, kind: 'shown', before: shownBefore, after: shownAfter }
        : { field, kind: 'redacted', before: null, after: null },
    );
  }
  return changes;
}

const VERBS: Readonly<Record<string, string>> = {
  create: 'created',
  update: 'updated',
  // #920's order actions (#921). `cancel` was falling through to the bare verb before.
  place: 'placed',
  cancel: 'cancelled',
  status_change: 'status changed',
  line_item_update: 'line quantity changed',
  line_item_cancel: 'line cancelled',
  ship: 'shipped',
  return: 'return received',
  exchange_link: 'linked to an exchange',
  delete: 'deleted',
  publish: 'published',
  archive: 'archived',
  activate: 'activated',
  revoke: 'revoked',
  erase: 'erased',
  capture: 'captured',
  capture_failed: 'capture failed',
  launch: 'launched',
  end: 'ended',
  block: 'blocked',
  redeem: 'redeemed',
  materialize: 'rebuilt',
  onboard: 'onboarded',
  upsert: 'set',
  download: 'downloaded',
  export_request: 'export requested',
  stock_item_mapped: 'mapped to a stock item',
};

/** `product.update` → `updated`; an unknown verb is spelled out rather than hidden. */
export function actionVerb(action: string): string {
  const verb = action.includes('.') ? action.slice(action.indexOf('.') + 1) : action;
  return VERBS[verb] ?? verb.replaceAll('_', ' ');
}

/** `product_variant` → `product variant`, for a sentence. */
export function entityLabel(entityType: string): string {
  return entityType.replaceAll('_', ' ');
}

/**
 * One line a reader can scan: what happened, then which fields.
 *
 * A redacted field still appears by name — "updated · settings, status" tells an owner where to
 * look even when the value is withheld.
 */
export function summarise(entry: AuditLike): string {
  const verb = actionVerb(entry.action);
  const changes = fieldChanges(entry);
  if (changes.length === 0) return verb;
  const names = changes.map((change) => change.field);
  const head = names.slice(0, 4).join(', ');
  return names.length > 4 ? `${verb} · ${head} +${names.length - 4} more` : `${verb} · ${head}`;
}
