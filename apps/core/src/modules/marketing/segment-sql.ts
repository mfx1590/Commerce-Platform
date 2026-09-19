// Compiles the frozen rule grammar into one parameterised SQL predicate (#147).
//
// Two properties this file exists to guarantee:
//
// 1. **Nothing from a rule is ever interpolated into SQL.** Every value becomes a `$n` parameter; only field and
//    operator names — both already checked against the closed set in `segment-rules.ts` — reach the string.
// 2. **Every predicate is total over real rows.** A customer with no orders, no address, no `metadata.tags` and
//    no consent block must still produce `true` or `false`, never an error and never a silent NULL that drops
//    them from a `not_in`. Marketing data is ragged; a rule engine that throws on ragged data is useless.
//
// Manager decisions baked in here (2026-09-19): `tags` reads `customer.metadata.tags` and a missing or non-array
// value simply does not match; `country` is the customer's **default shipping address only**, so a stale
// secondary address can never pull someone into a geo campaign; `customer_group_ids` is membership-in-list
// against the single `customer.customer_group_id` FK.
import type { SegmentPredicate, SegmentRules } from './segment-rules';

export interface CompiledRules {
  /** A boolean SQL expression over the aliases below. `TRUE` when the rule set is empty. */
  where: string;
  /** Values for the `$n` placeholders, in order, starting after the parameters the caller already used. */
  params: unknown[];
}

/**
 * The FROM/JOIN block every segment query shares. `$1` is the store id.
 *
 * `o` aggregates the customer's orders, `addr` picks the default shipping address. Both are LEFT JOINed, so a
 * customer with neither still appears as a row with NULLs — which is exactly what makes the predicates total.
 */
export const SEGMENT_FROM = `
  FROM customer c
  LEFT JOIN (
    SELECT customer_id,
           count(*)::int                          AS orders_count,
           COALESCE(sum(total_minor), 0)::bigint  AS total_spent_minor,
           max(placed_at)                         AS last_order_at
      FROM "order"
     WHERE store_id = $1 AND customer_id IS NOT NULL AND status <> 'cancelled'
     GROUP BY customer_id
  ) o ON o.customer_id = c.id
  LEFT JOIN (
    SELECT DISTINCT ON (customer_id) customer_id, country
      FROM customer_address
     WHERE store_id = $1 AND is_default_shipping
     ORDER BY customer_id, created_at, id
  ) addr ON addr.customer_id = c.id
 WHERE c.store_id = $1
   AND c.status NOT IN ('erased', 'disabled')`;

const CONSENT_KEY: Record<string, string> = { email: 'marketing_email', sms: 'marketing_sms' };

/** `customer.metadata.tags` as an array, or an empty array — the shape guard that makes `tags` total. */
const TAGS = `CASE WHEN jsonb_typeof(c.metadata->'tags') = 'array' THEN c.metadata->'tags' ELSE '[]'::jsonb END`;

function compilePredicate(p: SegmentPredicate, params: unknown[]): string {
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  switch (p.field) {
    case 'orders_count': {
      const op = p.op === 'gte' ? '>=' : p.op === 'lte' ? '<=' : '=';
      // No orders is zero orders, not "unknown": COALESCE keeps `orders_count lte 0` meaningful.
      return `COALESCE(o.orders_count, 0) ${op} ${bind(p.value)}`;
    }
    case 'total_spent_minor': {
      const op = p.op === 'gte' ? '>=' : p.op === 'lte' ? '<=' : '=';
      return `COALESCE(o.total_spent_minor, 0) ${op} ${bind(p.value)}::bigint`;
    }
    case 'last_order_at': {
      // NULL (never ordered) compares false either way, which is right for both directions.
      const op = p.op === 'after' ? '>' : '<';
      return `o.last_order_at ${op} ${bind(p.value)}::timestamptz`;
    }
    case 'tags': {
      const has = `${TAGS} @> to_jsonb(${bind(p.value)}::text)`;
      return p.op === 'includes' ? has : `NOT (${has})`;
    }
    case 'consent': {
      // Compared as jsonb rather than cast to boolean: a consent block holding a string would make `::boolean`
      // throw mid-query, and one malformed row must not fail a whole segment.
      //
      // `not_granted` is `IS DISTINCT FROM`, not `NOT (… = …)`. A customer who was never asked has no
      // `marketing_email` key, so the comparison is NULL and `NOT NULL` is NULL — which silently drops exactly
      // the people a re-consent campaign exists to reach. `IS DISTINCT FROM` is the two-valued form.
      const path = `c.consent->${bind(CONSENT_KEY[p.value]!)}->'granted'`;
      return p.op === 'granted'
        ? `${path} = 'true'::jsonb`
        : `${path} IS DISTINCT FROM 'true'::jsonb`;
    }
    case 'country': {
      const inList = `addr.country = ANY(${bind(p.value)}::text[])`;
      // No default shipping address: not in any country, so `not_in` matches and `in` does not.
      return p.op === 'in' ? inList : `(addr.country IS NULL OR NOT (${inList}))`;
    }
    case 'customer_group_ids': {
      const inList = `c.customer_group_id = ANY(${bind(p.value)}::uuid[])`;
      return p.op === 'in' ? inList : `(c.customer_group_id IS NULL OR NOT (${inList}))`;
    }
  }
}

/**
 * The rule set as one boolean expression. `startAt` is how many parameters the caller has already bound
 * (the store id is always `$1`, so callers pass 1).
 */
export function compileSegmentRules(rules: SegmentRules, startAt = 1): CompiledRules {
  const params: unknown[] = new Array(startAt).fill(undefined);
  const groups = rules.all.map((group) => {
    const ors = group.any.map((p) => compilePredicate(p, params));
    return ors.length === 1 ? ors[0]! : `(${ors.join(' OR ')})`;
  });
  return {
    // An empty rule set is every customer of the store, not none.
    where: groups.length === 0 ? 'TRUE' : groups.join(' AND '),
    params: params.slice(startAt),
  };
}

/** `SELECT <projection> FROM … WHERE store scope AND <rules>` — the one query shape preview and materialise share. */
export function segmentQuery(
  rules: SegmentRules,
  projection: string,
): { text: string; params: unknown[] } {
  const compiled = compileSegmentRules(rules, 1);
  return {
    text: `SELECT ${projection} ${SEGMENT_FROM} AND (${compiled.where})`,
    params: compiled.params,
  };
}
