import { describe, expect, it } from 'vitest';
import {
  currencyDigits,
  formatMoney,
  formatMoneyInput,
  moneyErrorMessage,
  parseMoney,
} from '@/lib/forms/money';

describe('currencyDigits', () => {
  it('knows the common cases', () => {
    expect(currencyDigits('EUR')).toBe(2);
    expect(currencyDigits('GBP')).toBe(2);
    expect(currencyDigits('USD')).toBe(2);
    expect(currencyDigits('JPY')).toBe(0);
  });

  it('falls back to two rather than throwing on nonsense', () => {
    expect(currencyDigits('nonsense')).toBe(2);
  });
});

describe('parseMoney', () => {
  it('parses whole and fractional amounts to integer minor units', () => {
    expect(parseMoney('12', 'EUR')).toEqual({ ok: true, amountMinor: 1200 });
    expect(parseMoney('12.5', 'EUR')).toEqual({ ok: true, amountMinor: 1250 });
    expect(parseMoney('12.50', 'EUR')).toEqual({ ok: true, amountMinor: 1250 });
    expect(parseMoney('0.07', 'EUR')).toEqual({ ok: true, amountMinor: 7 });
    expect(parseMoney('.5', 'EUR')).toEqual({ ok: true, amountMinor: 50 });
  });

  it('never loses a cent to floating point', () => {
    // 12.10 * 100 is 1209.9999999999998 — the whole reason this parses strings.
    expect(parseMoney('12.10', 'EUR')).toEqual({ ok: true, amountMinor: 1210 });
    expect(parseMoney('1.15', 'EUR')).toEqual({ ok: true, amountMinor: 115 });
    expect(parseMoney('870.29', 'EUR')).toEqual({ ok: true, amountMinor: 87029 });
  });

  it('accepts a comma as the decimal point', () => {
    expect(parseMoney('12,50', 'EUR')).toEqual({ ok: true, amountMinor: 1250 });
  });

  it('rejects group separators instead of guessing', () => {
    // 1,234 is genuinely ambiguous between 1234 and 1.234.
    expect(parseMoney('1,234.00', 'EUR')).toMatchObject({ ok: false });
    expect(parseMoney('1 234', 'EUR')).toMatchObject({ ok: false });
  });

  it('respects the currency decimal places', () => {
    expect(parseMoney('1200', 'JPY')).toEqual({ ok: true, amountMinor: 1200 });
    expect(parseMoney('12.5', 'JPY')).toMatchObject({ ok: false, reason: 'too_many_decimals' });
    expect(parseMoney('12.555', 'EUR')).toMatchObject({ ok: false, reason: 'too_many_decimals' });
  });

  it('rejects a negative amount unless it is allowed', () => {
    expect(parseMoney('-5', 'EUR')).toMatchObject({ ok: false, reason: 'negative' });
    expect(parseMoney('-5', 'EUR', { allowNegative: true })).toEqual({
      ok: true,
      amountMinor: -500,
    });
  });

  it('rejects what is not a number', () => {
    expect(parseMoney('', 'EUR')).toMatchObject({ ok: false, reason: 'empty' });
    expect(parseMoney('   ', 'EUR')).toMatchObject({ ok: false, reason: 'empty' });
    expect(parseMoney('abc', 'EUR')).toMatchObject({ ok: false, reason: 'not_a_number' });
    expect(parseMoney('.', 'EUR')).toMatchObject({ ok: false, reason: 'not_a_number' });
    expect(parseMoney('1.2.3', 'EUR')).toMatchObject({ ok: false, reason: 'not_a_number' });
  });
});

describe('formatMoneyInput', () => {
  it('round-trips through parseMoney', () => {
    for (const minor of [0, 7, 100, 1250, 87029, 999999]) {
      const text = formatMoneyInput(minor, 'EUR');
      expect(parseMoney(text, 'EUR')).toEqual({ ok: true, amountMinor: minor });
    }
  });

  it('pads amounts below one unit', () => {
    expect(formatMoneyInput(7, 'EUR')).toEqual('0.07');
    expect(formatMoneyInput(0, 'EUR')).toEqual('0.00');
  });

  it('omits the decimal point for zero-decimal currencies', () => {
    expect(formatMoneyInput(1200, 'JPY')).toEqual('1200');
  });

  it('keeps the sign', () => {
    expect(formatMoneyInput(-1250, 'EUR')).toEqual('-12.50');
  });
});

describe('formatMoney', () => {
  it('renders with the currency', () => {
    expect(formatMoney(1250, 'EUR', 'en-GB')).toContain('12.50');
    expect(formatMoney(1200, 'JPY', 'en-GB')).toContain('1,200');
  });

  it('degrades to the plain amount for an unknown code', () => {
    expect(formatMoney(1250, 'nonsense')).toEqual('12.50 nonsense');
  });
});

describe('moneyErrorMessage', () => {
  it('says how many decimals the currency allows', () => {
    expect(moneyErrorMessage('too_many_decimals', 'EUR')).toContain('at most 2');
    expect(moneyErrorMessage('too_many_decimals', 'JPY')).toContain('no decimal places');
  });
});
