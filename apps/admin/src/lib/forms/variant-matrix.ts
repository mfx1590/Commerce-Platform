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

/** "M / Red" — the conventional variant title, in the order the options were declared. */
export function variantTitle(
  combination: VariantCombination,
  options: readonly ProductOptionDraft[],
): string {
  return options
    .map((option) => combination[option.name])
    .filter((value): value is string => value !== undefined)
    .join(' / ');
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
