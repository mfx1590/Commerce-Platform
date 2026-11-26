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
  /**
   * ISO instants WITH their zone, or null (#963 review): the browser converts what the person typed
   * in their own time (`localToIso`) before the action is called. The server never reads a
   * zone-less time — it would read it in the SERVER's zone — and refuses one (`instantProblem`).
   */
  starts_at: string | null;
  ends_at: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------- times (#963 review)

/** An ISO date-time that names its zone: `Z` or an offset. */
const ZONED_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** Why a schedule time cannot be sent: not an instant, or no zone. Null when it can. */
export function instantProblem(value: string | null): string | null {
  if (value === null) return null;
  if (!ZONED_INSTANT.test(value) || Number.isNaN(Date.parse(value))) {
    return 'Not a date and time with its time zone.';
  }
  return null;
}

/**
 * BROWSER ONLY: a `datetime-local` value, read in the person's own zone, as a UTC instant; ''
 * as null; undefined when it is not a date and time. Never call it on the server: there the
 * zone-less value would be read in the server's zone.
 */
export function localToIso(value: string): string | null | undefined {
  if (value.trim() === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return undefined;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** BROWSER ONLY: an instant as a `datetime-local` value in the person's own zone (minutes). */
export function isoToLocalInput(iso: string | null): string {
  if (iso === null) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * BROWSER ONLY: what a schedule field sends. Untouched (the input still shows what it was opened
 * with) → the API's own value, byte for byte: the input has minutes only, so converting it back
 * would drop seconds and move the time. Changed → the typed local time as a UTC instant.
 */
export function scheduleValue(
  original: string | null,
  openedWith: string,
  input: string,
): string | null | undefined {
  return input === openedWith ? original : localToIso(input);
}

/** An instant for people: `2026-12-01 09:00 UTC` (always UTC, always said). */
export function utcLabel(iso: string | null): string {
  if (iso === null) return '—';
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** An instant for a file: ISO 8601 in UTC with its `Z`. */
function utcIso(iso: string | null): string {
  if (iso === null) return '';
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toISOString();
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
  const startsProblem = instantProblem(draft.starts_at);
  const endsProblem = instantProblem(draft.ends_at);
  if (startsProblem !== null) problems['starts_at'] = startsProblem;
  if (endsProblem !== null) problems['ends_at'] = endsProblem;
  if (
    startsProblem === null &&
    endsProblem === null &&
    draft.starts_at !== null &&
    draft.ends_at !== null &&
    Date.parse(draft.ends_at) <= Date.parse(draft.starts_at)
  ) {
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
      return {
        id: rule.id,
        outcome: 'skipped',
        why: `Not started: starts ${utcLabel(rule.starts_at)}.`,
      };
    }
    if (state === 'ended') {
      return { id: rule.id, outcome: 'skipped', why: `Ended ${utcLabel(rule.ends_at)}.` };
    }
    const stamped = time(rule.published_at);
    // A small allowance for the clocks of this server and the API's.
    return stamped !== null && stamped >= startedAt.getTime() - 5_000
      ? {
          id: rule.id,
          outcome: 'published',
          why: `In the index since ${utcLabel(rule.published_at)}.`,
        }
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
    utcIso(rule.starts_at),
    utcIso(rule.ends_at),
    utcIso(rule.published_at),
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
    // Sent as they are: instants the browser made (or the API's own, untouched).
    starts_at: draft.starts_at,
    ends_at: draft.ends_at,
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
