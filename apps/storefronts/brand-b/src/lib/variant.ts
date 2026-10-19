import type { Product, Variant } from './store-api';

/**
 * Option → variant resolution.
 *
 * A product declares its options as `[{ name, values }]`; each variant carries the concrete choice
 * as `options: { [name]: value }`. The PDP holds a selection and needs three answers: which variant
 * it names, whether that variant can be bought, and which values are still reachable so impossible
 * combinations can be disabled instead of 404-ing after a click.
 *
 * Pure functions — no React, no fetching — so the PDP's client component and the server render
 * agree by construction.
 */

export type Selection = Record<string, string>;

export function optionNames(product: Product): string[] {
  return product.options.map((option) => option.name);
}

/** The variant whose options equal the selection on every one of the product's option names. */
export function findVariant(product: Product, selection: Selection): Variant | undefined {
  const names = optionNames(product);
  if (names.some((name) => selection[name] === undefined)) return undefined;
  return product.variants.find((variant) =>
    names.every((name) => variant.options[name] === selection[name]),
  );
}

/** Can this variant be added to a cart? Backorder counts as available; unmanaged stock is unlimited. */
export function isPurchasable(variant: Variant | undefined): boolean {
  if (!variant) return false;
  if (variant.allow_backorder) return true;
  if (!variant.in_stock) return false;
  return variant.available_quantity === null || variant.available_quantity > 0;
}

export type Availability =
  | { state: 'in_stock' }
  | { state: 'low_stock'; quantity: number }
  | { state: 'backorder' }
  | { state: 'out_of_stock' };

/** Below this, the PDP says how many are left — the nudge only works when the number is small. */
export const LOW_STOCK_THRESHOLD = 10;

export function availability(variant: Variant | undefined): Availability {
  if (!variant) return { state: 'out_of_stock' };

  const quantity = variant.available_quantity;
  const hasStock = variant.in_stock && (quantity === null || quantity > 0);
  if (!hasStock)
    return variant.allow_backorder ? { state: 'backorder' } : { state: 'out_of_stock' };
  if (quantity !== null && quantity <= LOW_STOCK_THRESHOLD) {
    return { state: 'low_stock', quantity };
  }
  return { state: 'in_stock' };
}

/** The selection naming a variant. Used to seed the PDP from a variant the URL or API points at. */
export function selectionOf(variant: Variant): Selection {
  return { ...variant.options };
}

/**
 * What the PDP should show before the customer touches anything: the first purchasable variant,
 * falling back to the first variant so a sold-out product still renders its price and options.
 */
export function defaultSelection(product: Product): Selection {
  const purchasable = product.variants.find((variant) => isPurchasable(variant));
  const variant = purchasable ?? product.variants[0];
  return variant ? selectionOf(variant) : {};
}

/**
 * Values of `optionName` that still lead to a variant, holding every *other* chosen option fixed.
 * Lets the picker disable combinations that do not exist rather than letting them 404.
 */
export function reachableValues(
  product: Product,
  selection: Selection,
  optionName: string,
): Set<string> {
  const others = optionNames(product).filter((name) => name !== optionName);
  const reachable = new Set<string>();

  for (const variant of product.variants) {
    const matchesOthers = others.every((name) => {
      const chosen = selection[name];
      return chosen === undefined || variant.options[name] === chosen;
    });
    const value = variant.options[optionName];
    if (matchesOthers && value !== undefined) reachable.add(value);
  }
  return reachable;
}

/**
 * Apply one choice. Any other option that the new choice makes impossible is dropped, so the
 * selection never gets stuck in a combination no variant satisfies.
 */
export function withOption(
  product: Product,
  selection: Selection,
  name: string,
  value: string,
): Selection {
  const next: Selection = { ...selection, [name]: value };
  if (findVariant(product, next)) return next;

  for (const other of optionNames(product)) {
    if (other === name) continue;
    const stillReachable = reachableValues(product, { [name]: value }, other);
    const chosen = next[other];
    if (chosen !== undefined && !stillReachable.has(chosen)) delete next[other];
  }
  return next;
}

/** Media for the chosen variant, falling back to the product-wide images (`variant_id: null`). */
export function mediaFor(product: Product, variant: Variant | undefined): Product['media'] {
  const byPosition = (a: Product['media'][number], b: Product['media'][number]) =>
    a.position - b.position;
  const shared = product.media.filter((item) => item.variant_id === null);
  if (!variant) return [...product.media].sort(byPosition);

  const own = product.media.filter((item) => item.variant_id === variant.id);
  return [...own, ...shared].sort(byPosition);
}
