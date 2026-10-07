// Template tests (#360): both kinds × both locales, formatting by locale, escaping, the locale rule, brands.
import { describe, expect, it } from 'vitest';
import { applyLegalEntity, brandProfile, envKeyFor, parseSender } from '../brands.js';
import { escapeHtml, formatDate, formatMinor } from '../format.js';
import type { Locale, RenderContext } from '../types.js';
import { fixtureFor, pickLocale, render } from './index.js';

const brand = applyLegalEntity(brandProfile('brand-a', {})!, {
  name: 'Brand A B.V.',
  vatNumber: 'NL000000000B01',
});
const ctx = (locale: Locale): RenderContext => ({ brand, locale, timeZone: 'Europe/Amsterdam' });
/** Intl puts a no-break space between number and symbol; compare on a plain one. */
const NBSP = new RegExp(String.fromCharCode(0xa0), 'g');
const plain = (s: string): string => s.replace(NBSP, ' ');

describe('formatting', () => {
  it('formats minor units by locale and currency', () => {
    expect(plain(formatMinor(123456, 'EUR', 'de-DE'))).toBe('1.234,56 €');
    expect(formatMinor(123456, 'EUR', 'en-GB')).toBe('€1,234.56');
    expect(formatMinor(5, 'EUR', 'en-GB')).toBe('€0.05');
    // a zero-decimal currency is not divided by a guessed 100
    expect(formatMinor(123456, 'JPY', 'en-GB')).toMatch(/123,456$/);
  });

  it('formats dates in the store timezone', () => {
    expect(formatDate('2026-10-07T23:30:00.000Z', 'en-GB', 'Europe/Amsterdam')).toBe(
      '8 October 2026',
    );
    expect(formatDate('2026-10-07T23:30:00.000Z', 'de-DE', 'Europe/Amsterdam')).toBe(
      '8. Oktober 2026',
    );
  });

  it('escapes HTML', () => {
    expect(escapeHtml(`<a href="x">Tom & Jerry's</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;',
    );
  });
});

describe('order confirmation', () => {
  it('renders en-GB with totals, discount codes, shipping method and the legal footer', () => {
    const out = render('order_confirmation', fixtureFor('order_confirmation'), ctx('en-GB'));
    expect(out.subject).toBe('Your Brand A order #1042 is confirmed');
    expect(out.text).toContain('Hi Ada,');
    expect(out.text).toContain('Order number: #1042');
    expect(out.text).toContain('Placed on: 7 October 2026');
    expect(out.text).toContain('2 × Everyday Hoodie (Navy / M) — €90.00');
    expect(out.text).toContain('1 × Classic Cap — €19.99');
    expect(out.text).toContain('Subtotal: €109.99');
    expect(out.text).toContain('Discount (WELCOME10): −€10.00');
    expect(out.text).toContain('Shipping (Standard): €4.95');
    expect(out.text).toContain('VAT: €18.21');
    expect(out.text).toContain('Total: €104.94');
    expect(out.text).toContain('Keizersgracht 1');
    expect(out.text).toContain('1015 AA Amsterdam');
    expect(out.text).toContain('Brand A B.V.');
    expect(out.text).toContain('VAT no. NL000000000B01');
    expect(out.text).toContain('Imprint: https://brand-a.example/imprint');
    expect(out.html).toContain('<html lang="en">');
    expect(out.html).toContain('<title>Your Brand A order #1042 is confirmed</title>');
    expect(out.html).toContain('€104.94');
    expect(out.html).toContain('href="https://brand-a.example/privacy"');
    expect(out.html).toContain('support@brand-a.example');
  });

  it('renders de-DE with German copy and German number formatting', () => {
    const out = render('order_confirmation', fixtureFor('order_confirmation'), ctx('de-DE'));
    expect(out.subject).toBe('Ihre Bestellung #1042 bei Brand A ist bestätigt');
    expect(out.text).toContain('Hallo Ada,');
    expect(plain(out.text)).toContain('Gesamtbetrag: 104,94 €');
    expect(plain(out.text)).toContain('Rabatt (WELCOME10): −10,00 €');
    expect(plain(out.text)).toContain('Versand (Standard): 4,95 €');
    expect(out.text).toContain('Bestellt am: 7. Oktober 2026');
    expect(out.text).toContain('USt-IdNr. NL000000000B01');
    expect(out.html).toContain('<html lang="de">');
    expect(out.html).toContain('Lieferadresse');
    expect(out.html).not.toContain('Delivery address');
  });

  it('escapes customer-typed data and omits an empty discount row', () => {
    const data = fixtureFor('order_confirmation');
    data.lines[0]!.title = '<script>alert(1)</script>';
    data.shippingAddress.line1 = 'Tom & Jerry Lane';
    data.shippingAddress.first_name = '';
    data.totals.discountMinor = 0;
    data.promotionCodes = [];
    const out = render('order_confirmation', data, ctx('en-GB'));
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out.html).toContain('Tom &amp; Jerry Lane');
    expect(out.text).toContain('Tom & Jerry Lane');
    expect(out.text).not.toContain('Discount');
    expect(out.html).not.toContain('Discount');
    expect(out.text).toContain('Hello,');
  });
});

describe('shipment shipped', () => {
  it('renders the tracking details and the parcel contents', () => {
    const out = render('shipment_shipped', fixtureFor('shipment_shipped'), ctx('en-GB'));
    expect(out.subject).toBe('Your Brand A order #1042 is on its way');
    expect(out.text).toContain('Carrier: PostNL (Standard)');
    expect(out.text).toContain('Tracking number: 3SABCD123456789');
    expect(out.text).toContain('Track your parcel: https://tracking.example/3SABCD123456789');
    expect(out.text).toContain('2 × Everyday Hoodie (Navy / M)');
    expect(out.html).toContain('href="https://tracking.example/3SABCD123456789"');
    expect(out.html).toContain('Shipped on:</strong> 8 October 2026');
  });

  it('renders de-DE', () => {
    const out = render('shipment_shipped', fixtureFor('shipment_shipped'), ctx('de-DE'));
    expect(out.subject).toBe('Ihre Bestellung #1042 bei Brand A ist unterwegs');
    expect(out.text).toContain('Sendungsnummer: 3SABCD123456789');
    expect(out.text).toContain('Versandt am: 8. Oktober 2026');
  });

  it('never links a tracking URL that is not http(s), and copes with no tracking at all', () => {
    const data = fixtureFor('shipment_shipped');
    data.trackingUrl = 'javascript:alert(1)';
    const out = render('shipment_shipped', data, ctx('en-GB'));
    expect(out.html).not.toContain('javascript:');
    expect(out.text).not.toContain('Track your parcel');

    data.trackingUrl = null;
    data.trackingNumber = null;
    data.service = null;
    const bare = render('shipment_shipped', data, ctx('en-GB'));
    expect(bare.text).toContain('Carrier: PostNL');
    expect(bare.text).not.toContain('Tracking number');
    expect(bare.html).not.toContain('Tracking number');
  });
});

describe('pickLocale', () => {
  it('uses the order locale, then the language, then the brand default', () => {
    expect(pickLocale('de-DE', 'en-GB')).toBe('de-DE');
    expect(pickLocale('de_DE', 'en-GB')).toBe('de-DE');
    expect(pickLocale('de-AT', 'en-GB')).toBe('de-DE');
    expect(pickLocale('en-US', 'de-DE')).toBe('en-GB');
    expect(pickLocale('fr-FR', 'en-GB')).toBe('en-GB');
    expect(pickLocale(null, 'de-DE')).toBe('de-DE');
    expect(pickLocale('', 'de-DE')).toBe('de-DE');
  });
});

describe('brands', () => {
  it('parses a sender', () => {
    expect(parseSender('Brand A <orders@brand-a.example>', 'x')).toEqual({
      name: 'Brand A',
      email: 'orders@brand-a.example',
    });
    expect(parseSender('orders@brand-a.example', 'Fallback')).toEqual({
      name: 'Fallback',
      email: 'orders@brand-a.example',
    });
    expect(() => parseSender('not an address', 'x')).toThrow(/not a sender/);
  });

  it('applies environment overrides per brand and knows no other store', () => {
    expect(brandProfile('brand-b', {})).toBeNull();
    expect(envKeyFor('brand-a', 'SENDER')).toBe('NOTIFICATIONS_BRAND_A_SENDER');
    const p = brandProfile('brand-a', {
      NOTIFICATIONS_BRAND_A_SENDER: 'Brand A Orders <orders@brand-a.com>',
      NOTIFICATIONS_BRAND_A_LEGAL_ADDRESS: 'Keizersgracht 1, 1015 AA Amsterdam',
      NOTIFICATIONS_BRAND_A_REPLY_TO: 'help@brand-a.com',
    })!;
    expect(p.sender).toEqual({ name: 'Brand A Orders', email: 'orders@brand-a.com' });
    expect(p.replyTo).toBe('help@brand-a.com');
    expect(p.legal.address).toBe('Keizersgracht 1, 1015 AA Amsterdam');
    const out = render('order_confirmation', fixtureFor('order_confirmation'), {
      brand: applyLegalEntity(p, { name: 'Brand A B.V.', vatNumber: null }),
      locale: 'en-GB',
      timeZone: 'UTC',
    });
    expect(out.text).toContain('Brand A B.V. · Keizersgracht 1, 1015 AA Amsterdam');
    expect(out.text).not.toContain('VAT no.');
    expect(out.text).not.toContain('[registered address');
  });

  it('keeps the placeholder footer visible until the owner sets the address', () => {
    const out = render('order_confirmation', fixtureFor('order_confirmation'), ctx('en-GB'));
    expect(out.text).toContain('[registered address — set NOTIFICATIONS_BRAND_A_LEGAL_ADDRESS');
  });
});
