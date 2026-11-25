/**
 * Search merchandising rules (#870 wave 1 item 5, PR C; Opus review): pure helpers shared by the
 * rules screen and its server actions. One rule per store + scope (a category, or a whole search
 * query); pins (ordered, shown first), boosts (weight 1–100) and buries; enabled; an optional
 * window. `publishMerchandisingRules` replaces the index's rules with every enabled, in-window rule
 * and stamps `published_at` — it answers with counts only, so the per-rule result is read back
 * from the list (see `publishOutcomes`).
 */

import type { AdminComponents } from '../api/admin-client';
import type { CsvCell } from '../table/csv';

export type MerchandisingRule = AdminComponents['MerchandisingRule'];
export type MerchandisingScope = AdminComponents['MerchandisingScope'];

/** The contract's limits (MerchandisingRuleInput). */
export const PINS_MAX = 50;
export const BOOSTS_MAX = 200;
export const BURIES_MAX = 200;
export const QUERY_MAX = 200;

// ------------------------------------------------------------------------------------ state

export type RuleState = 'live' | 'disabled' | 'scheduled' | 'ended';

export const RULE_STATE_LABEL: Record<RuleState, string> = {
  live: 'Live',
  disabled: 'Disabled',
  scheduled: 'Scheduled',
  ended: 'Ended',
};

function time(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/** What the rule is at `now`: what a publish at `now` would do with it. */
export function ruleState(
  rule: Pick<MerchandisingRule, 'enabled' | 'starts_at' | 'ends_at'>,
  now: Date,
): RuleState {
  if (!rule.enabled) return 'disabled';
  const starts = time(rule.starts_at);
  const ends = time(rule.ends_at);
  if (starts !== null && starts > now.getTime()) return 'scheduled';
  if (ends !== null && ends <= now.getTime()) return 'ended';
  return 'live';
}

/**
 * Whether the rule changed since it was last published (or was never published): the index does
 * not have it as it is now until the next publish.
 */
export function unpublishedChange(
  rule: Pick<MerchandisingRule, 'published_at' | 'updated_at'>,
): 'never' | 'changed' | null {
  const published = time(rule.published_at);
  if (published === null) return 'never';
  const updated = time(rule.updated_at);
  return updated !== null && updated > published ? 'changed' : null;
}

export function scopeLabel(
  scope: MerchandisingScope,
  categoryNames: Readonly<Record<string, string>>,
): string {
  if (scope.type === 'query') return `Search “${scope.query ?? ''}”`;
  const id = scope.category_id ?? '';
  return `Category ${categoryNames[id] ?? `(unknown category ${id.slice(0, 8)})`}`;
}

// ---------------------------------------------------------------------------------- filters

/** The filters the rules screen keeps in the URL. The API has none: they apply to its full list. */
export const RULE_FILTER_KEYS = ['scope', 'state', 'category_id', 'q'] as const;

export function filterRules(
  rules: readonly MerchandisingRule[],
  filters: Readonly<Record<string, string | undefined>>,
  now: Date,
): MerchandisingRule[] {
  const scope = filters['scope'];
  const state = filters['state'];
  const category = filters['category_id'];
  const q = (filters['q'] ?? '').trim().toLowerCase();
  return rules.filter(
    (rule) =>
      (scope === undefined || scope === '' || rule.scope.type === scope) &&
      (state === undefined || state === '' || ruleState(rule, now) === state) &&
      (category === undefined || category === '' || rule.scope.category_id === category) &&
      (q === '' || (rule.scope.query ?? '').toLowerCase().includes(q)),
  );
}

/** Most useful first: by scope kind, then the category's name or the query. */
export function sortRules(
  rules: readonly MerchandisingRule[],
  categoryNames: Readonly<Record<string, string>>,
): MerchandisingRule[] {
  return [...rules].sort((a, b) =>
    scopeLabel(a.scope, categoryNames).localeCompare(scopeLabel(b.scope, categoryNames), 'en'),
  );
}

// ------------------------------------------------------------------------------- validation

export interface RuleDraft {
  scope: { type: 'category' | 'query'; category_id: string; query: string };
  pins: string[];
  boosts: { product_id: string; weight: number }[];
  buries: string[];
  enabled: boolean;
  /** `datetime-local` values (the person's local time) or ''. */
  starts_at: string;
  ends_at: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A `datetime-local` value as an ISO instant, '' as null; undefined when it is not a date. */
export function localToIso(value: string): string | null | undefined {
  if (value.trim() === '') return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** Problems with a draft, by field; empty when it may be sent. */
export function ruleProblems(draft: RuleDraft): Record<string, string> {
  const problems: Record<string, string> = {};
  if (draft.scope.type === 'category') {
    if (!UUID.test(draft.scope.category_id)) problems['scope'] = 'Choose the category.';
  } else {
    const query = draft.scope.query.trim();
    if (query === '') problems['scope'] = 'Type the search query the rule is for.';
    else if (query.length > QUERY_MAX)
      problems['scope'] = `Keep the query to ${QUERY_MAX} characters.`;
  }
  if (draft.pins.length > PINS_MAX) problems['pins'] = `At most ${PINS_MAX} pinned products.`;
  if (draft.boosts.length > BOOSTS_MAX)
    problems['boosts'] = `At most ${BOOSTS_MAX} boosted products.`;
  if (draft.buries.length > BURIES_MAX)
    problems['buries'] = `At most ${BURIES_MAX} buried products.`;
  if (draft.boosts.some((b) => !Number.isInteger(b.weight) || b.weight < 1 || b.weight > 100)) {
    problems['boosts'] = 'A boost weight is a whole number from 1 to 100.';
  }
  const all = [...draft.pins, ...draft.boosts.map((b) => b.product_id), ...draft.buries];
  if (all.some((id) => !UUID.test(id))) problems['form'] = 'A product in the lists is not valid.';
  else if (new Set(all).size !== all.length) {
    problems['form'] =
      'A product is in more than one list (or twice in one): pin, boost or bury it, once.';
  }
  const starts = localToIso(draft.starts_at);
  const ends = localToIso(draft.ends_at);
  if (starts === undefined) problems['starts_at'] = 'Not a date and time.';
  if (ends === undefined) problems['ends_at'] = 'Not a date and time.';
  if (typeof starts === 'string' && typeof ends === 'string' && ends <= starts) {
    problems['ends_at'] = 'The end must be after the start.';
  }
  return problems;
}

// --------------------------------------------------------------------------------- publish

export type PublishRow =
  | { id: string; outcome: 'published'; why: string }
  | { id: string; outcome: 'skipped'; why: string }
  | { id: string; outcome: 'not-confirmed'; why: string };

export interface PublishReport {
  index: string;
  /** The API's own counts. */
  published: number;
  skipped: number;
  rows: PublishRow[];
  /** Set when the API's counts and the rules read back after the publish disagree. */
  mismatch: string | null;
}

/**
 * Per rule, from the list read back after the publish (the API answers with counts only):
 * - expected in the index (enabled and in its window at `startedAt`) and stamped at or after
 *   `startedAt` → published;
 * - expected but not stamped → not confirmed (said; never reported as published);
 * - disabled / not started / ended → skipped, with the reason.
 * When the API's counts differ from these, `mismatch` says so: the screen shows both.
 */
export function publishOutcomes(
  answer: { index: string; published: number; skipped: number },
  after: readonly MerchandisingRule[],
  startedAt: Date,
): PublishReport {
  const rows: PublishRow[] = after.map((rule) => {
    const state = ruleState(rule, startedAt);
    if (state === 'disabled') return { id: rule.id, outcome: 'skipped', why: 'Disabled.' };
    if (state === 'scheduled') {
      return { id: rule.id, outcome: 'skipped', why: `Not started: starts ${rule.starts_at}.` };
    }
    if (state === 'ended') {
      return { id: rule.id, outcome: 'skipped', why: `Ended ${rule.ends_at}.` };
    }
    const stamped = time(rule.published_at);
    // A small allowance for the clocks of this server and the API's.
    return stamped !== null && stamped >= startedAt.getTime() - 5_000
      ? { id: rule.id, outcome: 'published', why: `In the index since ${rule.published_at}.` }
      : {
          id: rule.id,
          outcome: 'not-confirmed',
          why: 'Should be in the index, but its publish time was not updated: check it, then publish again.',
        };
  });
  const published = rows.filter((row) => row.outcome === 'published').length;
  const skipped = rows.filter((row) => row.outcome === 'skipped').length;
  const mismatch =
    published === answer.published && skipped === answer.skipped
      ? null
      : `The search service counted ${answer.published} published and ${answer.skipped} skipped; the rules read back show ${published} published and ${skipped} skipped. A rule may have changed during the publish: reload and check.`;
  return {
    index: answer.index,
    published: answer.published,
    skipped: answer.skipped,
    rows,
    mismatch,
  };
}

// ------------------------------------------------------------------------------------- CSV

export const RULES_CSV_HEADER = [
  'rule_id',
  'scope',
  'scope_type',
  'category_id',
  'query',
  'state',
  'enabled',
  'starts_at',
  'ends_at',
  'published_at',
  'unpublished_change',
  'pins',
  'boosts',
  'buries',
] as const;

/** One row per rule; products by name (id when the name is not known), in their list order. */
export function ruleCsvRow(
  rule: MerchandisingRule,
  names: {
    categories: Readonly<Record<string, string>>;
    products: Readonly<Record<string, string>>;
  },
  now: Date,
): CsvCell[] {
  const product = (id: string) => names.products[id] ?? id;
  return [
    rule.id,
    scopeLabel(rule.scope, names.categories),
    rule.scope.type,
    rule.scope.category_id ?? '',
    rule.scope.query ?? '',
    RULE_STATE_LABEL[ruleState(rule, now)],
    rule.enabled,
    rule.starts_at ?? '',
    rule.ends_at ?? '',
    rule.published_at ?? '',
    unpublishedChange(rule) ?? '',
    rule.pins.map(product).join(' | '),
    rule.boosts.map((b) => `${product(b.product_id)} (${b.weight})`).join(' | '),
    rule.buries.map(product).join(' | '),
  ];
}

// ------------------------------------------------------------------------------ to the API

/** The patch a valid draft sends: everything but the scope, which the API does not change. */
export function draftToPatch(draft: RuleDraft): AdminComponents['MerchandisingRulePatch'] {
  return {
    pins: [...draft.pins],
    boosts: draft.boosts.map((b) => ({ product_id: b.product_id, weight: b.weight })),
    buries: [...draft.buries],
    enabled: draft.enabled,
    starts_at: localToIso(draft.starts_at) ?? null,
    ends_at: localToIso(draft.ends_at) ?? null,
  };
}

export function draftToInput(draft: RuleDraft): AdminComponents['MerchandisingRuleInput'] {
  return {
    scope:
      draft.scope.type === 'category'
        ? { type: 'category', category_id: draft.scope.category_id }
        : { type: 'query', query: draft.scope.query.trim() },
    ...draftToPatch(draft),
    enabled: draft.enabled,
  };
}

/** What a publish now would do: the live rules go in, the rest are skipped. */
export function publishPreview(
  rules: readonly MerchandisingRule[],
  now: Date,
): { live: number; skipped: number } {
  const live = rules.filter((rule) => ruleState(rule, now) === 'live').length;
  return { live, skipped: rules.length - live };
}
