/**
 * The redaction rule (#870 wave 1 item 3).
 *
 * `listAuditLog` returns `before`/`after` as raw JSON bodies, typed `additionalProperties: true`.
 * The core is disciplined about what it writes there today, but the admin must not depend on that:
 * one new `writeAudit` call anywhere in the core changes what these screens render. So the rule is
 * an allow-list that fails closed, and this file is the thing that keeps it closed.
 *
 * The "sensitive" values below are deliberately NOT secret-shaped (CLAUDE.md: never write a
 * secret-shaped literal anywhere git keeps it). A marker string proves the same property: if it
 * reaches a rendered change or a CSV cell, the body leaked.
 */
import { describe, expect, it } from 'vitest';
import { auditCsv, csvCell, toAuditRow, type AuditRow } from '@/lib/audit/projection';
import {
  NEVER_SHOW,
  SAFE_VALUE_FIELDS,
  actionVerb,
  fieldChanges,
  formatValue,
  isSafeField,
  summarise,
} from '@/lib/audit/redaction';

const MARKER = 'LEAKED-BODY-MARKER';

const entry = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    id: '90000000-0000-4000-8000-000000000001',
    store_id: '00000000-0000-4000-8000-000000000031',
    actor_id: '00000000-0000-4000-8000-000000000044',
    actor_type: 'staff',
    action: 'product.update',
    entity_type: 'product',
    entity_id: '30000000-0000-4000-8000-000000000201',
    before: null,
    after: null,
    request_id: 'req_abc',
    created_at: '2026-11-13T12:00:00.000Z',
    ...over,
  }) as Parameters<typeof toAuditRow>[0];

describe('the allow-list decides what a value may show', () => {
  it('shows both sides for a reviewed (entity_type, field) pair', () => {
    const changes = fieldChanges({
      action: 'product.update',
      entity_type: 'product',
      before: { title: 'Classic T' },
      after: { title: 'Classic Tee' },
    });
    expect(changes).toEqual([
      { field: 'title', kind: 'shown', before: 'Classic T', after: 'Classic Tee' },
    ]);
  });

  it('names a field that is not on the list and withholds its value', () => {
    const changes = fieldChanges({
      action: 'product.update',
      entity_type: 'product',
      before: { internal_note: `old ${MARKER}` },
      after: { internal_note: `new ${MARKER}` },
    });
    expect(changes).toEqual([
      { field: 'internal_note', kind: 'redacted', before: null, after: null },
    ]);
    expect(JSON.stringify(changes)).not.toContain(MARKER);
  });

  it('an entity type nobody reviewed shows names only, never values', () => {
    // `store.update` writes the WHOLE Store object, which carries `psp_account_id` and `settings`.
    const changes = fieldChanges({
      action: 'store.update',
      entity_type: 'store',
      before: { name: 'Brand A', psp_account_id: MARKER },
      after: { name: 'Brand A EU', psp_account_id: `${MARKER}-2` },
    });
    expect(changes.map((c) => c.kind)).toEqual(['redacted', 'redacted']);
    expect(changes.map((c) => c.field)).toEqual(['name', 'psp_account_id']);
    expect(JSON.stringify(changes)).not.toContain(MARKER);
  });

  it('the deny pattern beats the allow-list, so extending it carelessly still cannot print', () => {
    // `title` is allow-listed for a product; a field whose NAME matches the pattern never is.
    expect(isSafeField('product', 'title')).toBe(true);
    expect(isSafeField('product', 'api_key')).toBe(false);
    expect(isSafeField('customer', 'email')).toBe(false);
    expect(isSafeField('customer', 'phone')).toBe(false);
  });

  it('no field on the allow-list matches the deny pattern (the two lists stay consistent)', () => {
    for (const [entityType, fields] of Object.entries(SAFE_VALUE_FIELDS)) {
      for (const field of fields) {
        expect(NEVER_SHOW.test(field), `${entityType}.${field} is denied and allowed`).toBe(false);
      }
    }
  });

  it('a nested object is redacted even on an allow-listed field — a blob hides there', () => {
    const changes = fieldChanges({
      action: 'product.update',
      entity_type: 'product',
      before: { title: { nested: MARKER } },
      after: { title: 'Classic Tee' },
    });
    expect(changes).toEqual([{ field: 'title', kind: 'redacted', before: null, after: null }]);
  });

  it('unchanged fields are not listed at all', () => {
    const changes = fieldChanges({
      action: 'product.update',
      entity_type: 'product',
      before: { title: 'Same', status: 'draft' },
      after: { title: 'Same', status: 'published' },
    });
    expect(changes.map((c) => c.field)).toEqual(['status']);
  });

  it("surfaces the core's own `changed_fields` list, by name", () => {
    // `customers/admin.ts` writes field names and non-personal values only.
    const changes = fieldChanges({
      action: 'customer.update',
      entity_type: 'customer',
      before: { status: 'active', customer_group_id: null },
      after: {
        status: 'active',
        customer_group_id: null,
        changed_fields: ['email', 'first_name'],
      },
    });
    expect(changes.map((c) => c.field)).toEqual(['email', 'first_name']);
    expect(changes.every((c) => c.kind === 'redacted')).toBe(true);
  });
});

describe('the two cases the review asked to be pinned by name', () => {
  it('a field the core starts writing tomorrow renders as a NAME, not a value', () => {
    // The whole reason this is an allow-list: a new `writeAudit` call in the core changes what
    // this screen renders without touching the admin. `product` HAS an allow-list, so this is the
    // realistic case — a new key arriving on an entity type that is already allow-listed.
    const changes = fieldChanges({
      action: 'product.update',
      entity_type: 'product',
      before: { supplier_cost_note: `old ${MARKER}` },
      after: { supplier_cost_note: `new ${MARKER}` },
    });
    expect(changes).toEqual([
      { field: 'supplier_cost_note', kind: 'redacted', before: null, after: null },
    ]);
    expect(JSON.stringify(changes)).not.toContain(MARKER);
    // And it is still NAMED in the summary, so the reader knows where to look.
    expect(
      summarise({
        action: 'product.update',
        entity_type: 'product',
        after: { supplier_cost_note: MARKER },
      }),
    ).toBe('updated · supplier_cost_note');
  });

  it('store.update never prints psp_account_id or settings, which it writes in full', () => {
    // `registry/service.ts` writes the WHOLE `Store` object as before/after.
    const changes = fieldChanges({
      action: 'store.update',
      entity_type: 'store',
      before: {
        name: 'Brand A',
        psp_account_id: `acct-${MARKER}`,
        settings: { payment: { invoice_allowed: false }, note: MARKER },
      },
      after: {
        name: 'Brand A EU',
        psp_account_id: `acct-${MARKER}-2`,
        settings: { payment: { invoice_allowed: true }, note: `${MARKER}!` },
      },
    });
    expect(changes.map((change) => change.field)).toEqual(['name', 'psp_account_id', 'settings']);
    expect(changes.every((change) => change.kind === 'redacted')).toBe(true);
    expect(JSON.stringify(changes)).not.toContain(MARKER);
    expect(JSON.stringify(changes)).not.toContain('invoice_allowed');
  });

  it("shows a stock movement's delta, which is the field the core actually writes", () => {
    // The first version allow-listed `quantity`, which nothing writes, so the one number a reader
    // wants was withheld (#896 review). `inventory/service.ts` writes `delta`.
    const changes = fieldChanges({
      action: 'stock_movement.create',
      entity_type: 'stock_movement',
      after: { delta: -3, reason: 'adjustment', addressed_variant_id: 'v1' },
    });
    expect(changes.find((change) => change.field === 'delta')).toEqual({
      field: 'delta',
      kind: 'shown',
      before: null,
      after: '-3',
    });
    // An id nobody reviewed stays a name.
    expect(changes.find((change) => change.field === 'addressed_variant_id')?.kind).toBe(
      'redacted',
    );
  });

  it('shows who was granted what, and never a staff user’s subject or email', () => {
    // `packages/auth-sdk` is the SECOND audit writer; the first version of this screen missed it.
    const grant = fieldChanges({
      action: 'role_assignment.create',
      entity_type: 'role_assignment',
      after: { relation: 'store_admin', object_type: 'store', object_id: 'store-1' },
    });
    expect(grant.map((change) => `${change.field}:${change.kind}`)).toEqual([
      'object_id:shown',
      'object_type:shown',
      'relation:shown',
    ]);

    const invited = fieldChanges({
      action: 'staff_user.create',
      entity_type: 'staff_user',
      after: { status: 'active', email: `${MARKER}@example.test`, keycloak_subject: MARKER },
    });
    expect(invited.find((change) => change.field === 'status')?.kind).toBe('shown');
    expect(invited.find((change) => change.field === 'email')?.kind).toBe('redacted');
    expect(invited.find((change) => change.field === 'keycloak_subject')?.kind).toBe('redacted');
    expect(JSON.stringify(invited)).not.toContain(MARKER);
  });
});

describe('formatValue', () => {
  it('renders scalars and names the absent and the empty', () => {
    expect(formatValue('Classic Tee')).toBe('Classic Tee');
    expect(formatValue(12)).toBe('12');
    expect(formatValue(false)).toBe('false');
    expect(formatValue(null)).toBe('none');
    expect(formatValue(undefined)).toBe('none');
    expect(formatValue('   ')).toBe('empty');
  });

  it('cuts a long value instead of wrapping the row, and refuses a structure', () => {
    const long = formatValue('x'.repeat(400));
    expect(long).toHaveLength(120);
    expect(long?.endsWith('…')).toBe(true);
    expect(formatValue({ a: 1 })).toBeNull();
    expect(formatValue([1, 2])).toBeNull();
  });
});

describe('summaries read as sentences', () => {
  it('names the verb, then the fields', () => {
    expect(actionVerb('product.publish')).toBe('published');
    expect(actionVerb('payment.capture_failed')).toBe('capture failed');
    expect(actionVerb('something.brand_new_verb')).toBe('brand new verb');
    expect(
      summarise({
        action: 'product.update',
        entity_type: 'product',
        before: { title: 'a' },
        after: { title: 'b' },
      }),
    ).toBe('updated · title');
  });

  it('a row with no body still says what happened', () => {
    expect(summarise({ action: 'product.create', entity_type: 'product' })).toBe('created');
  });
});

describe('the projected row is what crosses to the browser', () => {
  it('has no before/after at all, whatever the entry carried', () => {
    const row = toAuditRow(
      entry({ before: { secret_note: MARKER }, after: { secret_note: `${MARKER}!` } }),
    );
    expect('before' in row).toBe(false);
    expect('after' in row).toBe(false);
    expect(JSON.stringify(row)).not.toContain(MARKER);
    expect(row.changes.map((c) => c.field)).toEqual(['secret_note']);
  });

  it('names the actor, and labels what is not a person', () => {
    const staff = new Map([
      [
        '00000000-0000-4000-8000-000000000044',
        {
          id: '00000000-0000-4000-8000-000000000044',
          email: 'a@example.test',
          display_name: 'Ada Lovelace',
          status: 'active' as const,
          last_login_at: null,
        },
      ],
    ]);
    expect(toAuditRow(entry(), { staff }).actor).toEqual({ name: 'Ada Lovelace', kind: 'staff' });
    expect(toAuditRow(entry(), { staff, isServiceAccount: () => true }).actor.kind).toBe('service');
    expect(toAuditRow(entry({ actor_type: 'system', actor_id: null })).actor).toEqual({
      name: 'System',
      kind: 'system',
    });
    // A customer actor is never named: this screen is read by staff and has no reason to show it.
    expect(toAuditRow(entry({ actor_type: 'customer' })).actor).toEqual({
      name: 'Customer',
      kind: 'customer',
    });
  });

  it('an id that resolves to nobody says so rather than passing a uuid off as a name', () => {
    const actor = toAuditRow(entry()).actor;
    expect(actor.kind).toBe('unknown');
    expect(actor.name).toBe('Unknown staff (00000000)');
  });
});

describe('CSV export', () => {
  const row = (over: Partial<AuditRow> = {}): AuditRow => ({
    ...toAuditRow(entry({ before: { title: 'a' }, after: { title: 'b' } })),
    ...over,
  });

  it('writes the visible columns and never a body', () => {
    const csv = auditCsv([
      toAuditRow(entry({ before: { secret_note: MARKER }, after: { secret_note: `${MARKER}!` } })),
    ]);
    expect(csv).not.toContain(MARKER);
    expect(csv.split('\r\n')[0]).toContain('summary,changed_fields');
    expect(csv).toContain('secret_note');
  });

  it('quotes separators and neutralises a formula', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    // A product title is whatever somebody typed; a CSV is how it becomes a formula elsewhere.
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('labels an organization-level row rather than leaving the store blank', () => {
    expect(auditCsv([row({ store_id: null, store_label: null })])).toContain('organization');
  });
});
