import { NextIntlClientProvider } from 'next-intl';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import deDE from '../messages/de-DE.json';
import enGB from '../messages/en-GB.json';

/**
 * #351: the confirmation page says only what the platform did. No component sends email yet and
 * the order is `pending`, so no wording may claim a confirmation, an email sent, or a link "from
 * your email". This pins the header's text in both locales, signed in and as a guest.
 */

// The locale-aware Link needs Next's router; a plain anchor is enough to read the text and href.
vi.mock('@/i18n/navigation', () => ({
  Link: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: ReactNode;
    className?: string;
  }) => createElement('a', { href, className }, children),
}));

const { OrderConfirmationHeader } = await import('@/components/order-confirmation-header');

const ORDER = { id: 'order_word', display_id: 1136 };

function render(locale: 'en-GB' | 'de-DE', signedIn: boolean): string {
  const messages = locale === 'en-GB' ? enGB : deDE;
  const html = renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale,
      messages,
      timeZone: 'Europe/London',
      children: createElement(OrderConfirmationHeader, { order: ORDER, signedIn }),
    }),
  );
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const CLAIMS = {
  'en-GB': /e-?mail|sent|confirmed|confirmation/i,
  'de-DE': /e-?mail|gesendet|bestätigt|Bestätigung/i,
} as const;

describe('OrderConfirmationHeader', () => {
  it('en-GB, signed in: the number, placed and being processed, and Order history — no email', () => {
    const text = render('en-GB', true);
    expect(text).toContain('Order #1136 has been placed and is being processed.');
    expect(text).toContain('You can follow its status in your account: Order history');
    expect(text).not.toMatch(CLAIMS['en-GB']);
  });

  it('en-GB, guest: keeps the order number instead of pointing at an account', () => {
    const text = render('en-GB', false);
    expect(text).toContain('Order #1136 has been placed and is being processed.');
    expect(text).toContain('Please keep your order number, #1136');
    expect(text).not.toContain('Order history');
    expect(text).not.toMatch(CLAIMS['en-GB']);
  });

  it('de-DE says the same, with no claim of an email or a confirmation', () => {
    for (const signedIn of [true, false]) {
      const text = render('de-DE', signedIn);
      expect(text).toContain('Bestellung #1136 wurde aufgegeben und wird bearbeitet.');
      expect(text).not.toMatch(CLAIMS['de-DE']);
    }
  });

  it('links a signed-in customer to their order history', () => {
    const html = renderToStaticMarkup(
      createElement(NextIntlClientProvider, {
        locale: 'en-GB',
        messages: enGB,
        timeZone: 'Europe/London',
        children: createElement(OrderConfirmationHeader, { order: ORDER, signedIn: true }),
      }),
    );
    expect(html).toContain('href="/account/orders"');
    expect(html).toContain('data-order-number="1136"');
  });
});

describe('the confirmation copy', () => {
  it('claims no email anywhere — including the page shown when the order cannot be read', () => {
    for (const [locale, messages] of [
      ['en-GB', enGB],
      ['de-DE', deDE],
    ] as const) {
      const copy = Object.values(messages.checkout.confirmation).join(' ');
      expect(copy, locale).not.toMatch(/sent|gesendet|confirmation email|Bestätigungs-E-Mail/i);
      expect(copy, locale).not.toMatch(/is confirmed|ist bestätigt/i);
    }
  });
});
