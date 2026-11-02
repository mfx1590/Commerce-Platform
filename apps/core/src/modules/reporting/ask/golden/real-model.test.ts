// The real-model checker's reading of prose (#606), on answers the real model actually gave in the one run of
// 2026-11-02: dates are not figures; money in either notation is; a derived or wrong figure stays a figure.
import { describe, expect, it } from 'vitest';
import { figuresOf } from './real-model';

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
