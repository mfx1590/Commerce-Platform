import { describe, expect, it } from 'vitest';
import { formatChoice, parseChoice } from '@/lib/payment-choice';

/** #358: the remembered payment choice applies to its own cart and to known providers only. */
describe('parseChoice', () => {
  it('reads back what was stored for the same cart', () => {
    expect(parseChoice(formatChoice('cart_word', 'manual'), 'cart_word')).toBe('manual');
    expect(parseChoice(formatChoice('cart_word', 'stripe'), 'cart_word')).toBe('stripe');
  });

  it('ignores a choice made for another cart, an unknown provider and garbage', () => {
    expect(parseChoice(formatChoice('other_cart', 'manual'), 'cart_word')).toBeNull();
    for (const stored of [undefined, '', 'cart_word', 'cart_word:paypal', ':manual']) {
      expect(parseChoice(stored, 'cart_word'), String(stored)).toBeNull();
    }
  });
});
