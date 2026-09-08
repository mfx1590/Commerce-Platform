// Merchandising rule → Algolia Rule mapping (pure; unit-tested). One Algolia rule per merchandising rule:
// - category scope → condition `filters: category_id:<id>` (the Store API category listing passes that filter);
// - query scope → condition `pattern` + `anchoring: is` (the whole query, case-insensitive on Algolia's side);
// - pins → `consequence.promote` in order; buries → `consequence.hide`;
// - boosts → `consequence.params.optionalFilters` `objectID:<id><score=weight>` (Algolia's optional-filter scoring);
// - starts_at / ends_at → `validity` (unix seconds); `enabled` passes through.
import type { MerchandisingRule } from './merchandising-types';
import type { AlgoliaRule } from './types';

export const RULE_OBJECT_ID_PREFIX = 'merch_';

export function ruleObjectId(ruleId: string): string {
  return `${RULE_OBJECT_ID_PREFIX}${ruleId}`;
}

/** The filter expression the Store API sends for a category listing (and the rule condition matches). */
export function categoryFilter(categoryId: string): string {
  return `category_id:${categoryId}`;
}

export function toAlgoliaRule(rule: MerchandisingRule): AlgoliaRule {
  const condition =
    rule.scope.type === 'category'
      ? { filters: categoryFilter(rule.scope.category_id) }
      : { pattern: rule.scope.query, anchoring: 'is' as const };
  const consequence: AlgoliaRule['consequence'] = {};
  if (rule.pins.length > 0)
    consequence.promote = rule.pins.map((objectID, position) => ({ objectID, position }));
  if (rule.buries.length > 0) consequence.hide = rule.buries.map((objectID) => ({ objectID }));
  if (rule.boosts.length > 0)
    consequence.params = {
      optionalFilters: rule.boosts.map((b) => `objectID:${b.product_id}<score=${b.weight}>`),
    };
  const out: AlgoliaRule = {
    objectID: ruleObjectId(rule.id),
    description:
      rule.scope.type === 'category'
        ? `merchandising: category ${rule.scope.category_id}`
        : `merchandising: query "${rule.scope.query}"`,
    enabled: rule.enabled,
    conditions: [condition],
    consequence,
  };
  if (rule.starts_at || rule.ends_at) {
    const from = rule.starts_at ? Math.floor(new Date(rule.starts_at).getTime() / 1000) : 0;
    // Algolia needs both ends; "no end" = far future (year 2100)
    const until = rule.ends_at
      ? Math.floor(new Date(rule.ends_at).getTime() / 1000)
      : Math.floor(Date.UTC(2100, 0, 1) / 1000);
    out.validity = [{ from, until }];
  }
  return out;
}
