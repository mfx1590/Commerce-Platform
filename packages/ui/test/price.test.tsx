import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Price, formatMoney, minorUnitDigits } from '../src/index.js';

/** ICU puts U+00A0 / U+202F between number and symbol; compare on plain spaces. */
const plain = (value: string) => value.replace(/[\u00a0\u202f]/g, ' ');

describe('formatMoney', () => {
  it('formats 1999 EUR per locale', () => {
    expect(plain(formatMoney({ amount_minor: 1999, currency: 'EUR' }, 'en-GB'))).toBe('€19.99');
    expect(plain(formatMoney({ amount_minor: 1999, currency: 'EUR' }, 'de-DE'))).toBe('19,99 €');
  });

  it('formats USD in en-US', () => {
    expect(plain(formatMoney({ amount_minor: 1999, currency: 'USD' }, 'en-US'))).toBe('$19.99');
  });

  it('formats GBP in en-GB', () => {
    expect(plain(formatMoney({ amount_minor: 1999, currency: 'GBP' }, 'en-GB'))).toBe('£19.99');
  });

  it('respects the currency minor unit exponent', () => {
    expect(minorUnitDigits('EUR')).toBe(2);
    expect(minorUnitDigits('JPY')).toBe(0);
    expect(plain(formatMoney({ amount_minor: 1999, currency: 'JPY' }, 'en-US'))).toBe('¥1,999');
  });

  it('handles zero and large amounts', () => {
    expect(plain(formatMoney({ amount_minor: 0, currency: 'USD' }, 'en-US'))).toBe('$0.00');
    expect(plain(formatMoney({ amount_minor: 123456789, currency: 'USD' }, 'en-US'))).toBe(
      '$1,234,567.89',
    );
  });

  it('does not throw on an unknown currency code', () => {
    expect(plain(formatMoney({ amount_minor: 1999, currency: 'XYZ' }, 'en-US'))).toContain('XYZ');
  });
});

describe('Price', () => {
  it('renders the formatted value', () => {
    render(<Price value={{ amount_minor: 1999, currency: 'EUR' }} locale="de-DE" />);
    expect(plain(screen.getByTestId('price-value').textContent ?? '')).toBe('19,99 €');
  });

  it('strikes through a higher compare-at price', () => {
    render(
      <Price
        value={{ amount_minor: 1999, currency: 'EUR' }}
        compareAt={{ amount_minor: 2999, currency: 'EUR' }}
        locale="en-GB"
      />,
    );
    const compareAt = screen.getByTestId('price-compare-at');
    expect(plain(compareAt.textContent ?? '')).toBe('€29.99');
    expect(compareAt.tagName).toBe('S');
    expect(compareAt).toHaveAccessibleName('Original price');
  });

  it('hides compare-at when it is not actually higher or is another currency', () => {
    const { rerender } = render(
      <Price
        value={{ amount_minor: 1999, currency: 'EUR' }}
        compareAt={{ amount_minor: 1999, currency: 'EUR' }}
      />,
    );
    expect(screen.queryByTestId('price-compare-at')).toBeNull();

    rerender(
      <Price
        value={{ amount_minor: 1999, currency: 'EUR' }}
        compareAt={{ amount_minor: 2999, currency: 'USD' }}
      />,
    );
    expect(screen.queryByTestId('price-compare-at')).toBeNull();
  });
});
