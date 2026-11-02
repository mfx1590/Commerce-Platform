// The real-model checker's reading of prose (#606), on answers the real model actually gave in the one run of
// 2026-11-02: dates are not figures; money in either notation is; a derived or wrong figure stays a figure.
import { describe, expect, it } from 'vitest';
import { checkDerived, figuresOf } from './real-model';

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
  ])('%j → %j', (text, figures) => {
    expect(figuresOf(text)).toEqual(figures);
  });

  it('a wrong derived figure is still a figure, so the check catches it (#23 of the real run: 8091.80 ≠ 8090.80)', () => {
    expect(figuresOf('The difference is 8,091.80 EUR.')).toEqual(['8091.80']);
  });
});

// bi-qa-answer@2's labelled derived figure, recomputed from the results it cites (#23: bookings [q1] − net [q2])
describe('checkDerived', () => {
  const results: Record<number, Set<string>> = {
    1: new Set(['44922.65', '77']),
    2: new Set(['36831.85', '31']),
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
    ['a sum', '81,754.50 EUR (derived: 44,922.65 [q1] + 36,831.85 [q2])', []],
    ['a difference with an ASCII -', '46 (derived: 77 [q1] - 31 [q2])', []],
    ['a ratio, half-up to 2 decimals (77 / 31 = 2.4838…)', '2.48 (derived: 77 [q1] / 31 [q2])', []],
    [
      'a ratio rounded the wrong way',
      '2.49 (derived: 77 [q1] / 31 [q2])',
      ['derived 2.49 ≠ 77 / 31 (2.48)'],
    ],
    [
      'a decimal comma (an answer in German)',
      '8.090,80 EUR (derived: 44.922,65 EUR [q1] − 36.831,85 EUR [q2])',
      [],
    ],
    [
      'an input cited to the wrong result',
      '46 (derived: 77 [q2] − 31 [q1])',
      ['derived input 77 is not in [q2]', 'derived input 31 is not in [q1]'],
    ],
    [
      'a ref that ran nothing',
      '46 (derived: 77 [q1] − 31 [q9])',
      ['derived input 31 is not in [q9]'],
    ],
    [
      'two currencies',
      '8,090.80 EUR (derived: 44,922.65 EUR [q1] − 36,831.85 USD [q2])',
      ['derived 8,090.80 mixes currencies: EUR, USD'],
    ],
  ])('%s', (_, text, problems) => {
    expect(check(text).problems).toEqual(problems);
  });
});
