/**
 * Product options expand to variants as their cross-product: Size [S,M,L] × Colour [Red,Blue] is
 * six variants, not two lists.
 *
 * This is the one calculation in the catalog form that is easy to get subtly wrong and expensive to
 * get wrong — an operator who adds a colour expects six variants to become nine, and silently
 * producing three would corrupt a catalog. So it is a pure function with its own tests, and the
 * form only renders what it returns.
 */

export interface ProductOptionDraft {
  name: string;
  values: readonly string[];
}

/** One variant's option assignment, e.g. `{ Size: 'M', Colour: 'Red' }`. */
export type VariantCombination = Readonly<Record<string, string>>;

/**
 * Every combination, in a stable order: the last option varies fastest, so the list reads the way
 * the inputs do (S/Red, S/Blue, M/Red, …).
 *
 * Returns an empty list — never a partial one — if any option has no values, because a "variant"
 * missing one of the product's options is not a variant the catalog can accept.
 */
export function variantMatrix(options: readonly ProductOptionDraft[]): VariantCombination[] {
  const usable = options.filter((option) => option.name.trim() !== '');
  if (usable.length === 0) return [];
  if (usable.some((option) => option.values.filter((value) => value.trim() !== '').length === 0)) {
    return [];
  }

  return usable.reduce<VariantCombination[]>(
    (combinations, option) => {
      const values = option.values.filter((value) => value.trim() !== '');
      return combinations.flatMap((combination) =>
        values.map((value) => ({ ...combination, [option.name]: value })),
      );
    },
    [{}],
  );
}

/** A no-options product's single variant (#820): the core requires a title, and there is no value. */
export const DEFAULT_VARIANT_TITLE = 'Default';

/** "M / Red" — the conventional variant title, in the order the options were declared. */
export function variantTitle(
  combination: VariantCombination,
  options: readonly ProductOptionDraft[],
): string {
  const title = options
    .map((option) => combination[option.name])
    .filter((value): value is string => value !== undefined)
    .join(' / ');
  return title === '' ? DEFAULT_VARIANT_TITLE : title;
}

/**
 * A suggested SKU: the product handle plus each value, uppercased and punctuation-stripped.
 * Only a starting point — SKUs are the operator's to decide, so the form leaves them editable.
 */
export function suggestSku(handle: string, combination: VariantCombination): string {
  const slug = (value: string) =>
    value
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '')
      .slice(0, 8);
  const base = slug(handle);
  const parts = Object.values(combination)
    .map(slug)
    .filter((part) => part !== '');
  return [base, ...parts].filter((part) => part !== '').join('-');
}

/** How many variants the current options would create — the number the form warns about. */
export function variantCount(options: readonly ProductOptionDraft[]): number {
  return variantMatrix(options).length;
}

/** The subset of a `Variant` this reconciliation needs — anything with an option assignment. */
export interface ExistingVariant {
  options: Readonly<Record<string, string>>;
}

/** Two combinations are the same variant when every option maps to the same value. */
export function sameCombination(a: VariantCombination, b: VariantCombination): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/**
 * Which rows of the matrix have no variant yet.
 *
 * The product page offers these for creation instead of creating them on save: adding a colour to a
 * live product would otherwise silently POST several new variants, and a variant is a sellable
 * thing with its own SKU and price. Explicit beats convenient here for the same reason the
 * data-table refuses to select a whole result set behind a single checkbox.
 */
export function missingCombinations(
  options: readonly ProductOptionDraft[],
  existing: readonly ExistingVariant[],
): VariantCombination[] {
  // A product with no options has exactly one variant, the empty combination (#820). It is
  // different from options that are named but still have no values, where the matrix is empty on
  // purpose until every option has at least one.
  const named = options.filter((option) => option.name.trim() !== '');
  const matrix = named.length === 0 ? [{}] : variantMatrix(options);
  return matrix.filter(
    (combination) => !existing.some((variant) => sameCombination(variant.options, combination)),
  );
}
