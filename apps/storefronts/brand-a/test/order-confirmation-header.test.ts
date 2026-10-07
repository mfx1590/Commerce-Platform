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

const ORDER = { id: 'order_word', display_id: 1136, status: 'pending' as const };

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

describe('OrderConfirmationHeader — the order status (#372)', () => {
  const at = (
    status: 'processing' | 'completed' | 'cancelled',
    locale: 'en-GB' | 'de-DE' = 'en-GB',
  ) =>
    renderToStaticMarkup(
      createElement(NextIntlClientProvider, {
        locale,
        messages: locale === 'en-GB' ? enGB : deDE,
        timeZone: 'Europe/London',
        children: createElement(OrderConfirmationHeader, {
          order: { ...ORDER, status },
          signedIn: false,
        }),
      }),
    );
  const text = (html: string) =>
    html
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  it('shows the status the API sent, as text and as data-order-status', () => {
    const shipped = at('processing');
    expect(shipped).toContain('data-order-status="processing"');
    expect(text(shipped)).toContain('Status: Processing');
    expect(text(shipped)).toContain('Order #1136 is on its way.');

    const delivered = at('completed');
    expect(delivered).toContain('data-order-status="completed"');
    expect(text(delivered)).toContain('Status: Completed');
    expect(text(delivered)).toContain('Order #1136 has been delivered.');
  });

  it('never calls a delivered or cancelled order "being processed"', () => {
    for (const status of ['completed', 'cancelled'] as const) {
      expect(text(at(status)), status).not.toContain('being processed');
      expect(text(at(status, 'de-DE')), status).not.toContain('wird bearbeitet');
    }
  });

  it('a pending order is received and being processed', () => {
    const html = renderToStaticMarkup(
      createElement(NextIntlClientProvider, {
        locale: 'en-GB',
        messages: enGB,
        timeZone: 'Europe/London',
        children: createElement(OrderConfirmationHeader, { order: ORDER, signedIn: false }),
      }),
    );
    expect(text(html)).toContain('Status: Received');
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
