// No PII in ClickHouse (#600): the raw_events rows of a generated month (every topic and version) are swept for
// e-mail, phone, name and address shapes, in keys and in values. `email_hash` is the allowed form (sha256).
import { createValidator } from '@platform/events';
import { describe, expect, it } from 'vitest';
import { classify, type RawEventRow } from './rows.js';
import { toWire } from './testing/fakes.js';
import { generateMonth } from './testing/month.js';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE = /\+?\d[\d ()-]{7,}\d/;
/** Keys that would hold personal data (a bare `name` is a campaign's or a product's, not a person's); `*_hash` keys are the allowed form. */
const PII_KEY =
  /^(e?mail|email_address|phone|phone_number|mobile|first_name|last_name|full_name|customer_name|billing_name|shipping_name|given_name|family_name|address|address_1|address_2|address_line_1|address_line_2|street|postcode|postal_code|zip|city|ip|ip_address|birth_date|dob)$/i;

function sweep(value: unknown, path: string, hits: string[]): void {
  if (typeof value === 'string') {
    // uuids, sha256 hex and timestamps are long digit runs too: test the phone shape on what is left
    const stripped = value
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '')
      .replace(/[0-9a-f]{64}/g, '')
      .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, '');
    if (EMAIL.test(value)) hits.push(`${path}: e-mail shape`);
    if (PHONE.test(stripped)) hits.push(`${path}: phone shape`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => sweep(v, `${path}[${i}]`, hits));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (PII_KEY.test(k)) hits.push(`${path}.${k}: personal-data key`);
      sweep(v, `${path}.${k}`, hits);
    }
  }
}

describe('PII sweep over raw_events', () => {
  const month = generateMonth({ perKey: 10 });
  const validator = createValidator();
  const now = new Date('2026-10-31T23:00:00Z');
  const rows: RawEventRow[] = month.events.map((e, i) => {
    const c = classify(
      toWire(e, i),
      { topic: e.topic, partition: 0 },
      {
        groupId: 'analytics.raw',
        validator,
        now,
      },
    );
    if (c.kind !== 'row') throw new Error(`generated event ${e.topic} was dead-lettered`);
    return c.row;
  });

  it('covers every topic and version', () => {
    expect(new Set(rows.map((r) => `${r.topic}@${r.version}`)).size).toBe(
      Object.keys(month.perKey).length,
    );
  });

  it('finds 0 e-mail, phone, name or address shapes in any column', () => {
    const hits: string[] = [];
    for (const r of rows) {
      sweep(JSON.parse(r.payload), `${r.topic}.payload`, hits);
      const { payload: _payload, ...columns } = r;
      sweep(columns, `${r.topic}`, hits);
    }
    expect(hits).toEqual([]);
  });

  it('the sweep itself catches each shape (a planted row is found)', () => {
    const hits: string[] = [];
    sweep(
      {
        first_name: 'x',
        contact: 'someone@shop.example',
        note: 'call +44 20 7946 0000',
        email_hash: 'f'.repeat(64),
      },
      'planted',
      hits,
    );
    expect(hits).toEqual([
      'planted.first_name: personal-data key',
      'planted.contact: e-mail shape',
      'planted.note: phone shape',
    ]);
  });
});
