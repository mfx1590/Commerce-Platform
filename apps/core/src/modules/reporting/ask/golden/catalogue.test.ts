// The live golden set's catalogue (#7): valid product.published events, every generated variant published exactly
// once, a skewed split per store, and the same month on every run.
import { createValidator, type EventEnvelope, type EventEnvelopeV1Base } from '@platform/events';
import { generateMonth, ORG } from '@platform/test-utils';
import { describe, expect, it } from 'vitest';
import { catalogueFor, PRODUCTS_PER_STORE } from './catalogue';

const month = generateMonth({ orders: 300, legalEntities: 3, deterministicIds: true, seed: 6060 });
const events = month.events as unknown as EventEnvelopeV1Base[];
const catalogue = catalogueFor(events, ORG);
type Published = EventEnvelope<'product.published'>;

describe('catalogueFor', () => {
  it('every event is a valid product.published', () => {
    const validator = createValidator();
    expect(catalogue.length).toBeGreaterThan(0);
    for (const e of catalogue) {
      expect(e.topic).toBe('product.published');
      expect(validator.validateEnvelope(e)).toMatchObject({ ok: true });
    }
  });

  it('publishes every generated variant exactly once, under its own store', () => {
    const lines = events
      .filter((e) => e.topic === 'order.placed')
      .flatMap((e) =>
        (e as unknown as EventEnvelope<'order.placed'>).payload.line_items
          .filter((l) => l.variant_id)
          .map((l) => `${e.store_id} ${l.variant_id}`),
      );
    const published = catalogue.flatMap((e) =>
      (e as unknown as Published).payload.variants.map((v) => `${e.store_id} ${v.variant_id}`),
    );
    expect(published.sort()).toEqual(lines.sort());
  });

  it('per store: at most PRODUCTS_PER_STORE products, at least five, with a skewed (strictly falling) top five', () => {
    const stores = new Set(catalogue.map((e) => e.store_id));
    for (const s of stores) {
      const sizes = catalogue
        .filter((e) => e.store_id === s)
        .map((e) => (e as unknown as Published).payload.variants.length);
      expect(sizes.length).toBeLessThanOrEqual(PRODUCTS_PER_STORE);
      expect(sizes.length).toBeGreaterThanOrEqual(5);
      const top = sizes.slice(0, 5);
      for (let i = 1; i < top.length; i++) expect(top[i]!).toBeLessThan(top[i - 1]!);
    }
  });

  it('is deterministic: the same ids and variants on every call', () => {
    expect(catalogueFor(events, ORG)).toEqual(catalogue);
  });
});
