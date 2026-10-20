// Pure rules of the account self-service forms (#470). Picked up once window 3's vitest include covers
// `src/**/*.test.ts` (REQUEST filed with #470); until then: run with an include override.
import { describe, expect, it } from 'vitest';
import {
  addressPatchFromForm,
  DELETE_CONFIRMATION,
  exportDownloadPath,
  exportStatus,
  isDeleteConfirmed,
} from './account.config';

const form = (entries: Record<string, string>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
};

const full = {
  first_name: ' Jane ',
  last_name: 'Doe',
  line1: 'Keizersgracht 1',
  city: 'Amsterdam',
  postal_code: '1015 CJ',
  country: 'nl',
  company: '',
  line2: '',
  region: '',
  phone: '',
};

describe('addressPatchFromForm', () => {
  it('sends every field: required ones trimmed, the country upper-cased, blank optional ones as null (cleared)', () => {
    expect(addressPatchFromForm(form(full))).toEqual({
      errors: {},
      patch: {
        first_name: 'Jane',
        last_name: 'Doe',
        line1: 'Keizersgracht 1',
        city: 'Amsterdam',
        postal_code: '1015 CJ',
        country: 'NL',
        company: null,
        line2: null,
        region: null,
        phone: null,
      },
    });
  });

  it('a blank required field and a non-alpha-2 country are field errors, no patch', () => {
    const r = addressPatchFromForm(form({ ...full, city: '  ', country: 'Netherlands' }));
    expect(r.patch).toBeUndefined();
    expect(r.errors).toEqual({
      city: 'City is required',
      country: 'Use the two-letter country code, e.g. NL',
    });
  });

  it('a default checkbox is sent only as true: unticked means "leave it", never "give it up"', () => {
    const on = addressPatchFromForm(form({ ...full, is_default_shipping: 'on' })).patch!;
    expect(on.is_default_shipping).toBe(true);
    expect(on.is_default_billing).toBeUndefined();
    const off = addressPatchFromForm(form(full)).patch!;
    expect(off.is_default_shipping).toBeUndefined();
    expect(off.is_default_billing).toBeUndefined();
  });
});

describe('exports panel (#472)', () => {
  it('says ready-until for a ready export, being prepared for a pending one, too large or expired for the rest', () => {
    expect(
      exportStatus({ status: 'ready', reason: null, expires_at: '2026-11-17T10:00:00Z' }),
    ).toEqual({
      key: 'until',
      date: '2026-11-17T10:00:00Z',
    });
    expect(exportStatus({ status: 'pending', reason: null, expires_at: null })).toEqual({
      key: 'pending',
      date: null,
    });
    expect(exportStatus({ status: 'expired', reason: 'too_large', expires_at: null })).toEqual({
      key: 'tooLarge',
      date: null,
    });
    expect(exportStatus({ status: 'expired', reason: 'customer_gone', expires_at: null })).toEqual({
      key: 'expired',
      date: null,
    });
    expect(
      exportStatus({ status: 'expired', reason: null, expires_at: '2026-10-01T10:00:00Z' }),
    ).toEqual({ key: 'expired', date: null });
  });

  it('links the download under the locale the customer is browsing (no middleware redirect)', () => {
    expect(exportDownloadPath('de-DE', '30000000-0000-4000-8000-000000000e01')).toBe(
      '/de-DE/account/exports/30000000-0000-4000-8000-000000000e01',
    );
  });
});

describe('isDeleteConfirmed', () => {
  it('accepts the exact word (surrounding whitespace tolerated), nothing else', () => {
    expect(DELETE_CONFIRMATION).toBe('DELETE');
    expect(isDeleteConfirmed('DELETE')).toBe(true);
    expect(isDeleteConfirmed(' DELETE ')).toBe(true);
    for (const bad of ['delete', 'DELET', 'DELETE!', '', null]) {
      expect(isDeleteConfirmed(bad), String(bad)).toBe(false);
    }
  });
});
