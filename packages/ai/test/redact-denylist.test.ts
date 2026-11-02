import { describe, expect, it } from 'vitest';
import { findDeniedFields, redact } from '../src/index.js';

describe('redact', () => {
  it('masks e-mail addresses', () => {
    const r = redact('Write to anna.de.vries+shop@example.co.uk or bob@shop.nl please');
    expect(r.text).toBe('Write to [email] or [email] please');
    expect(r.counts.email).toBe(2);
  });

  it('masks card numbers that pass the Luhn check, grouped or not, and leaves other long numbers', () => {
    // the well-known public test PAN (passes Luhn), assembled at runtime so no card-shaped literal sits in git
    const groups = ['4111', ...Array<string>(3).fill('1111')];
    const r = redact(`card ${groups.join(' ')} and ${groups.join('-')} and ${groups.join('')}`);
    expect(r.text).toBe('card [card] and [card] and [card]');
    expect(redact('order 1234567890123').text).toBe('order 1234567890123'); // fails Luhn
  });

  it('masks valid IBANs only', () => {
    expect(redact('pay to NL91 ABNA 0417 1643 00 today').text).toBe('pay to [iban] today');
    expect(redact('pay to NL91ABNA0417164300').counts.iban).toBe(1);
    expect(redact('code NL00ABNA0000000000').counts.iban).toBe(0); // mod-97 fails
  });

  it('masks phone numbers with at least nine digits, leaves sizes, prices and years', () => {
    expect(redact('call +31 6 1234 5678 now').text).toBe('call [phone] now');
    expect(redact('call 020-555 1234 now').counts.phone).toBe(1);
    expect(redact('call (020) 555 1234').counts.phone).toBe(1);
    // international numbers without separators: the + must reach the phone check (#661 review)
    expect(redact('Call +31612345678 now').text).toBe('Call [phone] now');
    expect(redact('Call +447946095800 now').text).toBe('Call [phone] now');
    expect(redact('Call +14155552671 now').text).toBe('Call [phone] now');
    expect(redact('Call +1 (415) 555-2671 now').text).toBe('Call [phone] now');
    expect(redact('Call 0031612345678 now').text).toBe('Call [phone] now');
    // bare long numbers stay: a GTIN-13 and an order number (both fail Luhn, neither looks like a phone)
    for (const keep of ['GTIN 8712345678906', 'order 1234567890123', 'SKU 4006381333931']) {
      expect(redact(keep).text, keep).toBe(keep);
    }
    const keep = redact('A 2024 linen shirt, 120 x 80 cm, € 49.95, 500 ml, model 7731');
    expect(keep.total).toBe(0);
    expect(keep.text).toBe('A 2024 linen shirt, 120 x 80 cm, € 49.95, 500 ml, model 7731');
  });

  it('masks street addresses and postcodes in NL, UK, DE, FR and US shapes', () => {
    expect(redact('Damstraat 12, 1012 JS Amsterdam').text).toBe('[address], [address]');
    expect(redact('lives at Baker Street 221B').text).toBe('lives at [address]');
    expect(redact('221B Baker Street').text).toBe('[address]');
    expect(redact('Hauptstraße 5a in Berlin').text).toBe('[address] in Berlin');
    expect(redact('12 rue de la Paix').counts.address).toBe(1);
    expect(redact('London SW1A 1AA').text).toBe('London [address]');
    expect(redact('Springfield, IL 62704').text).toBe('[address]');
  });

  it('masks the common carriers’ tracking numbers: UPS 1Z…, DHL 10 digits and JJD…, PostNL 3S… (#671)', () => {
    const r = redact(
      'UPS 1Z999AA10123456784, ups 1z999aa10123456784, DHL 1234567890, JJD000390007827411, PostNL 3SABCD1234567',
    );
    expect(r.text).toBe(
      'UPS [tracking], ups [tracking], DHL [tracking], [tracking], PostNL [tracking]',
    );
    expect(r.counts.tracking).toBe(5);
    // GTIN-13, UPC-12, a 13-digit order number, 9- and 11-digit runs, and a short order number stay
    for (const keep of [
      'GTIN 8712345678906',
      'UPC 725272730706',
      'order 1234567890123',
      'ref 123456789',
      'ref 12345678901',
      'order 1042',
    ])
      expect(redact(keep).text, keep).toBe(keep);
    // a bare 10-digit run is masked even when it is a phone number; it is masked either way
    expect(redact('call 4155552671').text).toBe('call [tracking]');
  });

  it('leaves uuids intact, in any case and inside JSON; PII beside them is still masked (#680)', () => {
    const ids = ['00000000-0000-4000-8000-000000000031', '5a1b2c3d-1111-4222-8333-444455556666'];
    for (const id of [...ids, ids[1]!.toUpperCase()]) {
      expect(redact(`store ${id}`), id).toMatchObject({ text: `store ${id}`, total: 0 });
    }
    const json = JSON.stringify({ rows: [{ store_id: ids[0], order_id: ids[1], n: 2 }] });
    expect(redact(json)).toMatchObject({ text: json, total: 0 });
    // a phone, a card, a tracking number and an e-mail right next to uuids
    const card = ['4111', ...Array<string>(3).fill('1111')].join(' '); // public test PAN, assembled at runtime
    const r = redact(
      `${ids[0]} +31612345678 ${ids[1]}, ${ids[1]}:020-555 1234; ${card} ${ids[0]} DHL 1234567890`,
    );
    expect(r.text).toBe(
      `${ids[0]} [phone] ${ids[1]}, ${ids[1]}:[phone]; [card] ${ids[0]} DHL [tracking]`,
    );
    // e-mail is masked before uuids are set aside, so a uuid local part does not shield the address
    expect(redact(`mail ${ids[1]}@example.org`).text).toBe('mail [email]');
    // not a uuid (a 7-character first group): its digit runs are judged as before
    expect(redact('ref 0000000-0000-4000-8000-000000000031').counts.phone).toBeGreaterThan(0);
  });

  it('does NOT mask names, an e-mail spelled out in words, or an unknown carrier’s number (documented residuals)', () => {
    const text = 'Anna de Vries, anna at example dot org, GLS 12345678901234';
    // GLS: 14 digits, fails Luhn → not a card; not phone-shaped → stays
    expect(redact(text).text).toBe(text);
  });

  it('leaves ordinary product copy alone', () => {
    const copy =
      'Soft linen shirt in sea blue. Relaxed fit, mother-of-pearl buttons. Machine wash at 30 degrees.';
    expect(redact(copy)).toMatchObject({ text: copy, total: 0 });
  });
});

describe('denylisted customer fields (runtime half of the guard)', () => {
  it('finds denied keys at any depth, in any spelling, and nothing in clean input', () => {
    expect(findDeniedFields({ productTitle: 'x', locale: 'nl-NL' })).toEqual([]);
    expect(findDeniedFields({ email: 'x' })).toEqual(['email']);
    expect(findDeniedFields({ Phone_Number: 'x', meta: { postal_code: 'x' } })).toEqual([
      'Phone_Number',
      'meta.postal_code',
    ]);
    expect(findDeniedFields({ list: [{ ok: 1 }, { firstName: 'x' }] })).toEqual([
      'list[1].firstName',
    ]);
    expect(findDeniedFields({ 'last-name': 'x', IBAN: 'x', cardNumber: 'x' })).toEqual([
      'last-name',
      'IBAN',
      'cardNumber',
    ]);
  });
});
