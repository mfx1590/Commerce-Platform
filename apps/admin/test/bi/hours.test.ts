// Admin API 0.4.31 (#935): distribution metrics are hours with one decimal — MetricRow.values, the totals and the
// comparison changes are `number`, no longer integers. The BI model reads and formats them without rounding them
// away or treating them as money.
import { describe, expect, it } from 'vitest';
import { displayUnitOf, formatChange, formatValue } from '@/app/(hq)/bi/_v2/model';

describe('hours (distribution metrics, #935)', () => {
  it('a definition with unit hours displays as hours with one decimal, never as a currency', () => {
    const unit = displayUnitOf({ unit: 'hours' } as never, 'hours_to_ship_p50');
    expect(unit).toBe('hours');
    expect(formatValue(10.5, unit, 'EUR')).toBe('10.5 h');
    expect(formatValue(48, unit, null)).toBe('48 h');
    expect(formatValue(null, unit, null)).toBe('not computed');
  });

  it('a change is a difference in hours; the API sends no % for a distribution', () => {
    expect(formatChange(-2.5, null, 'hours', null)).toBe('−2.5 h');
  });
});
