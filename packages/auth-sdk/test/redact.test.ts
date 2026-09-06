// PII redaction for audit snapshots (issue #14). Pure unit tests, always run.
import { describe, expect, it } from 'vitest';
import { PII_FIELDS, REDACTED, redactPii } from '../src/index.js';

describe('redactPii', () => {
  it('replaces email but keeps ids and status readable', () => {
    const after = {
      id: '00000000-0000-4000-8000-000000000044',
      email: 'store-admin@example.com',
      status: 'disabled',
    };
    expect(redactPii(after)).toEqual({
      id: '00000000-0000-4000-8000-000000000044',
      email: REDACTED,
      status: 'disabled',
    });
    expect(after.email).toBe('store-admin@example.com'); // input untouched
  });

  it('covers the issue #14 field list (email, phone, address lines, key_hash)', () => {
    for (const f of ['email', 'phone', 'line1', 'line2', 'key_hash']) {
      expect(PII_FIELDS).toContain(f);
      expect(redactPii({ [f]: 'x' })).toEqual({ [f]: REDACTED });
    }
  });

  it('walks nested objects and arrays, case-insensitively', () => {
    const value = {
      order_id: 'o1',
      shipping_address: { line1: 'Main St 1', Line2: 'Apt 2', city: 'Amsterdam', country: 'NL' },
      contacts: [{ Email: 'a@b.c', role: 'billing' }],
    };
    expect(redactPii(value)).toEqual({
      order_id: 'o1',
      shipping_address: { line1: REDACTED, Line2: REDACTED, city: 'Amsterdam', country: 'NL' },
      contacts: [{ Email: REDACTED, role: 'billing' }],
    });
  });

  it('passes through null, undefined and scalars; null PII values stay null', () => {
    expect(redactPii(null)).toBeNull();
    expect(redactPii(undefined)).toBeUndefined();
    expect(redactPii('plain')).toBe('plain');
    expect(redactPii({ email: null, phone: undefined })).toEqual({
      email: null,
      phone: undefined,
    });
  });
});
