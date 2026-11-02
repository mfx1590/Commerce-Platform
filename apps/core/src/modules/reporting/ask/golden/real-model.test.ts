// The real-model checker's reading of prose (#606), on answers the real model actually gave in the one run of
// 2026-11-02: dates are not figures; money in either notation is; a derived or wrong figure stays a figure.
import { describe, expect, it } from 'vitest';
import { checkDerived, figuresOf, type ResultValue } from './real-model';

describe('figuresOf', () => {
  it.each([
    ['Bookings in October 2026 were 44,922.65 EUR, from 77 orders [q1].', ['44922.65', '77']],
    [
      'Refunds by reason for 1–31 October 2026, all in EUR [q1]:\n- Cancellation: 12,221.30 EUR',
      ['12221.30'],
    ],
    ['Net bookings per week: - Week of 28 Sep: 1,946.30', ['1946.30']],
    ['Daily counts [q1]:\n- Oct 1, 2 and 3: 2 orders each.\n- Oct 4: 1.', ['2', '1']],
    ["The result's data timestamp is 2026-11-01T00:00:00Z. 0 orders [q1].", ['0']],
    ['- Reservas (bookings): 44.922,65 EUR [q1]\n- AOV: 583,41 EUR [q1]', ['44922.65', '583.41']],
    ['That averages about 2.5 a day over the 31 days.', ['2.5', '31']],
    // #683 review: each number on its own — German thousands with and without decimals
    ['Umsatz 1.250.000,00 EUR aus 1.234 Bestellungen [q1].', ['1250000.00', '1234']],
    ['Revenue 1,250,000.00 EUR from 1,234 orders [q1].', ['1250000.00', '1234']],
    // the re-run of 2026-11-02: #8 wrote week starts without a year
    ['Week of 09-28: 1,946.30; 10-26 to 10-31: 2,001.10 [q1]', ['1946.30', '2001.10']],
    ['Semana del 28/09: 1.946,30 EUR [q1]', ['1946.30']],
    ['Weeks 09-28 and 10-05 [q1].', []],
    // not dates: a count range, two-digit pairs that are no month and day
    [
      'Between 5-10 orders a day, 13-14 refunds, 45-60 units [q1].',
      ['5', '10', '13', '14', '45', '60'],
    ],
    // #686 review: never inside a decimal — a wrong range must stay checkable
    ['Prices ran 12.10-12.50 EUR [q1].', ['12.10', '12.50']],
    ['AOV 12,10/12,50 EUR [q1].', ['12.10', '12.50']],
    // #686 review: a pair followed by a count word, a currency or arithmetic is a quantity
    ['10-20 orders a day [q1].', ['10', '20']],
    ['10/12 stores reported [q1].', ['10', '12']],
    ['Between 10-12 EUR per order [q1].', ['10', '12']],
    ['31-12 = 19 more [q1].', ['31', '12', '19']],
  ])('%j → %j', (text, figures) => {
    expect(figuresOf(text)).toEqual(figures);
  });

  it('the gap left, pinned: a bare pair that is also a date reads as a date', () => {
    expect(figuresOf('We saw 10-12 of them [q1].')).toEqual([]);
  });

  // #686 review: only the case's own store ids are not figures — a foreign or invented uuid is reported
  const OWN = '00000000-0000-4000-8000-000000000031';
  it.each([
    [
      'its own store id (#18 quoted it from <stores>)',
      `I only have brand-a (store ${OWN}), 42 orders [q1].`,
      ['42'],
    ],
    ['in upper case', `store ${OWN.toUpperCase()}: 42 orders [q1].`, ['42']],
    [
      'another store id',
      'store 00000000-0000-4000-8000-000000000032 had 42 orders [q1].',
      ['00000000', '0000', '4000', '8000', '000000000032', '42'],
    ],
    [
      'an invented id',
      'product 5a1b2c3d-1111-4222-8333-444455556666 sold 42 [q1].',
      ['5', '1', '2', '3', '1111', '4222', '8333', '444455556666', '42'],
    ],
  ])('uuids: %s', (_, text, figures) => {
    expect(figuresOf(text, [OWN])).toEqual(figures);
  });

  it('a wrong derived figure is still a figure, so the check catches it (#23 of the real run: 8091.80 ≠ 8090.80)', () => {
    expect(figuresOf('The difference is 8,091.80 EUR.')).toEqual(['8091.80']);
  });
});

// bi-qa-answer@2 / @3's labelled derived figure, recomputed from the results it cites (#23: bookings [q1] − net [q2]).
// The checker is the net for wrong figures (#683 review): every case below that should fail must fail.
describe('checkDerived', () => {
  const money = (currency: string, minor: number): ResultValue => ({
    hundredths: BigInt(minor),
    currency,
    unit: 'money',
  });
  const count = (n: number): ResultValue => ({
    hundredths: BigInt(n) * 100n,
    currency: null,
    unit: 'count',
  });
  const results: Record<number, ResultValue[]> = {
    1: [money('EUR', 4_492_265), count(77)],
    2: [money('EUR', 3_683_185), count(31)],
    3: [money('USD', 3_683_185)],
    4: [money('EUR', -50_000)], // a real negative (net after refunds)
    5: [count(1), count(8)],
    6: [money('EUR', 125_000_000), money('EUR', 123_400)],
    7: [count(95), count(190)],
    8: [count(83), count(96)],
  };
  const check = (text: string) => checkDerived(text, (ref) => results[ref]);

  it('#23 as the model wrote it now fails: 8,091.80 is not 44,922.65 − 36,831.85', () => {
    const r = check(
      'Refunds made the gap 8,091.80 EUR (derived: 44,922.65 EUR [q1] − 36,831.85 EUR [q2]).',
    );
    expect(r.problems).toEqual(['derived 8,091.80 ≠ 44,922.65 − 36,831.85 (8090.80)']);
  });

  it('the right value passes, and its span is blanked for the every-figure check', () => {
    const r = check('The gap is 8,090.80 EUR (derived: 44,922.65 EUR [q1] − 36,831.85 EUR [q2]).');
    expect(r.problems).toEqual([]);
    expect(figuresOf(r.rest)).toEqual([]);
  });

  it.each([
    // the forms that hold
    ['a sum', '81,754.50 EUR (derived: 44,922.65 [q1] + 36,831.85 [q2])', []],
    ['a difference of counts with an ASCII -', '46 (derived: 77 [q1] - 31 [q2])', []],
    ['a ratio, half-up (77 / 31 = 2.4838…)', '2.48 (derived: 77 [q1] / 31 [q2])', []],
    ['a ratio exactly on the half (1 / 8 = 0.125 → 0.13)', '0.13 (derived: 1 [q5] / 8 [q5])', []],
    ['a ratio with a negative input', '-0.01 (derived: -500.00 [q4] / 44,922.65 [q1])', []],
    [
      'a real negative input, signed',
      '45,422.65 EUR (derived: 44,922.65 EUR [q1] − -500.00 EUR [q4])',
      [],
    ],
    [
      'a decimal comma (an answer in German)',
      '8.090,80 EUR (derived: 44.922,65 EUR [q1] − 36.831,85 EUR [q2])',
      [],
    ],
    [
      'German thousands, per number',
      '1.248.766,00 EUR (derived: 1.250.000,00 EUR [q6] − 1.234 EUR [q6])',
      [],
    ],
    // finding 1: the sign is part of the value
    [
      'a sign-flipped input (77 − -31 = 108)',
      '108 (derived: 77 [q1] − -31 [q2])',
      ['derived input -31 is not in [q2]'],
    ],
    [
      'a negative input written positive',
      '45,422.65 EUR (derived: 44,922.65 EUR [q1] + 500.00 EUR [q4])',
      ['derived input 500.00 is not in [q4]'],
    ],
    // finding 2: currency and unit from the data, labels must agree
    [
      'two currencies, unlabelled',
      '8,090.80 (derived: 44,922.65 [q1] − 36,831.85 [q3])',
      ['derived 8,090.80 combines EUR money with USD money'],
    ],
    [
      'a USD value labelled EUR',
      '8,090.80 EUR (derived: 44,922.65 EUR [q1] − 36,831.85 EUR [q3])',
      ['derived input 36,831.85 is labelled EUR; [q3] holds it as USD money'],
    ],
    [
      'the result labelled in another currency',
      '8,090.80 USD (derived: 44,922.65 [q1] − 36,831.85 [q2])',
      ['derived 8,090.80 is labelled USD; its inputs are EUR money'],
    ],
    [
      'a count minus an amount',
      '-36,754.85 (derived: 77 [q1] − 36,831.85 [q2])',
      ['derived -36,754.85 combines count with EUR money'],
    ],
    [
      'a ratio with a currency',
      '1.22 EUR (derived: 44,922.65 [q1] / 36,831.85 [q2])',
      ['derived ratio 1.22 carries a currency (EUR)'],
    ],
    // finding 3: at most 2 decimals; the ratio exact
    [
      'a figure with 4 decimals',
      '2.4838 (derived: 77 [q1] / 31 [q2])',
      ['derived figure 2.4838 has more than 2 decimals or does not read'],
    ],
    [
      'a ratio rounded the wrong way',
      '2.49 (derived: 77 [q1] / 31 [q2])',
      ['derived 2.49 ≠ 77 / 31 (2.48)'],
    ],
    [
      'a ratio rounded down on the half',
      '0.12 (derived: 1 [q5] / 8 [q5])',
      ['derived 0.12 ≠ 1 / 8 (0.13)'],
    ],
    // cited to the wrong result, or to nothing
    [
      'inputs cited to the wrong results',
      '46 (derived: 77 [q2] − 31 [q1])',
      ['derived input 77 is not in [q2]', 'derived input 31 is not in [q1]'],
    ],
    [
      'a ref that ran nothing',
      '46 (derived: 77 [q1] − 31 [q9])',
      ['derived input 31 is not in [q9]'],
    ],
    // finding 5: one derived figure, in the one form
    [
      'two derived figures',
      '46 (derived: 77 [q1] − 31 [q2]); 2.48 (derived: 77 [q1] / 31 [q2])',
      ['2 derived figures (at most one)'],
    ],
    [
      'a derived figure in another form',
      '2.48 (derived: 77 [q1] ÷ 31 [q2])',
      ['a derived figure not in the form "x (derived: a [qi] op b [qj])"'],
    ],
  ])('%s', (_, text, problems) => {
    expect(check(text).problems).toEqual(problems);
  });

  // the template's own examples, word for word (#684 review), so the template and the checker cannot drift apart
  it.each([
    ['a count difference, then the noun', '12 (derived: 95 [q7] − 83 [q8]) more orders', []],
    ['a ratio, then "times as many"', '1.98 (derived: 190 [q7] / 96 [q8]) times as many', []],
    [
      'the same ratio with a wrong value (190 / 96 = 1.979… → 1.98)',
      '1.97 (derived: 190 [q7] / 96 [q8]) times as many',
      ['derived 1.97 ≠ 190 / 96 (1.98)'],
    ],
    [
      'the noun between the figure and its label',
      '12 more orders (derived: 95 [q7] − 83 [q8])',
      ['a derived figure not in the form "x (derived: a [qi] op b [qj])"'],
    ],
  ])('template form: %s', (_, text, problems) => {
    expect(check(text).problems).toEqual(problems);
  });
});
