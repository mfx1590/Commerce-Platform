/**
 * HQ › Finance (#851): the pure half — the permission rule, the page's search params read safely
 * against the Accounting API's declared parameters, and what the trial balance says per currency.
 *
 * Money stays integer minor units with its currency; nothing here ever adds amounts of two
 * currencies together.
 */
import type { AccountingQuery, TrialBalance } from '../api/accounting-client';
import type { PermissionRule } from '../permissions/rules';

/** Every accounting operation's `x-permission` (accounting.yaml): finance on organization:hq. */
export const FINANCE_RULE: PermissionRule = { relation: 'finance', object: 'organization' };

export const FINANCE_TABS = ['trial-balance', 'journal', 'payouts', 'ops'] as const;
export type FinanceTab = (typeof FINANCE_TABS)[number];

type JournalQuery = AccountingQuery<'listJournalLines'>;
type PayoutsQuery = AccountingQuery<'listPayouts'>;

/** The contract's enums, pinned to the generated types (a contract change breaks the build here). */
export const JOURNALS = [
  'sales',
  'psp_fees',
  'refunds',
  'cogs',
  'tax',
  'shipping',
  'bank',
] as const satisfies readonly NonNullable<JournalQuery['journal']>[];
export const REFERENCE_TYPES = [
  'order',
  'payment',
  'refund',
  'shipment',
  'payout',
] as const satisfies readonly NonNullable<JournalQuery['reference_type']>[];
export const PAYOUT_STATUSES = [
  'imported',
  'reconciled',
  'discrepant',
] as const satisfies readonly NonNullable<PayoutsQuery['status']>[];

/** What each line verdict means, in words (PayoutLine.match_status). */
export const MATCH_LABELS: Record<string, string> = {
  pending: 'Not checked yet',
  matched: 'Matched',
  unmatched: 'No ledger entry',
  amount_mismatch: 'Amount differs',
  fee_mismatch: 'Fee differs',
};

const PROVIDER = /^[a-z0-9_-]{1,32}$/;

export const ERP_STATES = ['posted', 'unposted'] as const satisfies readonly NonNullable<
  JournalQuery['erp']
>[];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY = /^[A-Z]{3}$/;
const ACCOUNT_CODE = /^[A-Za-z0-9._-]{1,32}$/;

type Params = Record<string, string | string[] | undefined>;

function one(params: Params, key: string): string | undefined {
  const value = params[key];
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first.trim() === '' ? undefined : first.trim();
}

/** A real calendar date as YYYY-MM-DD, or undefined. */
export function isoDate(value: string | undefined): string | undefined {
  if (value === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
    ? value
    : undefined;
}

function oneOf<T extends string>(allowed: readonly T[], value: string | undefined): T | undefined {
  return allowed.find((each) => each === value);
}

export interface FinanceView {
  entity: string | null;
  tab: FinanceTab;
  period: { from?: string; to?: string };
  currency?: string;
  journal: JournalQuery;
  payouts: PayoutsQuery;
  /** `page` for the parked events (ops tab). */
  parked: { page?: number };
  /** What was typed but ignored, said on the page rather than silently dropped. */
  ignored: string[];
}

/**
 * The page's search params as the Accounting API's query. Anything malformed is left out (and
 * named in `ignored`), so a hand-edited URL is never a 400 panel, and nothing undeclared is sent.
 */
export function readFinanceView(params: Params): FinanceView {
  const ignored: string[] = [];
  const keep = <T>(key: string, value: T | undefined): T | undefined => {
    if (value === undefined && one(params, key) !== undefined) ignored.push(key);
    return value;
  };
  const entity = keep(
    'entity',
    UUID.test(one(params, 'entity') ?? '') ? one(params, 'entity') : undefined,
  );
  const from = keep('from', isoDate(one(params, 'from')));
  let to = keep('to', isoDate(one(params, 'to')));
  if (from !== undefined && to !== undefined && to < from) {
    ignored.push('to');
    to = undefined;
  }
  const currency = keep(
    'currency',
    CURRENCY.test(one(params, 'currency') ?? '') ? one(params, 'currency') : undefined,
  );
  const pageText = one(params, 'page');
  const page = keep(
    'page',
    pageText !== undefined && /^[1-9]\d{0,5}$/.test(pageText) ? Number(pageText) : undefined,
  );
  const period = { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  const journal: JournalQuery = {
    ...period,
    ...(currency ? { currency } : {}),
    ...(page ? { page } : {}),
  };
  const filters = {
    journal: keep('journal', oneOf(JOURNALS, one(params, 'journal'))),
    account_code: keep(
      'account_code',
      ACCOUNT_CODE.test(one(params, 'account_code') ?? '')
        ? one(params, 'account_code')
        : undefined,
    ),
    reference_type: keep('reference_type', oneOf(REFERENCE_TYPES, one(params, 'reference_type'))),
    reference_id: keep(
      'reference_id',
      UUID.test(one(params, 'reference_id') ?? '') ? one(params, 'reference_id') : undefined,
    ),
    erp: keep('erp', oneOf(ERP_STATES, one(params, 'erp'))),
  };
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined) (journal as Record<string, unknown>)[key] = value;
  }
  const status = keep('status', oneOf(PAYOUT_STATUSES, one(params, 'status')));
  const provider = keep(
    'provider',
    PROVIDER.test(one(params, 'provider') ?? '') ? one(params, 'provider') : undefined,
  );
  // Payouts declare no `currency`: it is never sent to listPayouts.
  const payouts: PayoutsQuery = {
    ...period,
    ...(status ? { status } : {}),
    ...(provider ? { provider } : {}),
    ...(page ? { page } : {}),
  };
  return {
    entity: entity ?? null,
    tab: oneOf(FINANCE_TABS, one(params, 'tab')) ?? 'trial-balance',
    period,
    ...(currency ? { currency } : {}),
    journal,
    payouts,
    parked: page ? { page } : {},
    ignored,
  };
}

/** A Finance URL for the same view with some params changed (undefined removes one). */
export function financeHref(
  view: { entity: string | null; tab: FinanceTab },
  params: Record<string, string | number | undefined>,
): string {
  const search = new URLSearchParams();
  if (view.entity !== null) search.set('entity', view.entity);
  search.set('tab', view.tab);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  return `/finance?${search.toString()}`;
}

export type CurrencyBalance = {
  currency: string;
  debit_minor: number;
  credit_minor: number;
  difference_minor: number;
  balanced: boolean;
};

/**
 * Per currency, never across: the service's own totals, each balanced only when its difference is
 * zero. An empty list means the period has no lines — the page says so instead of "balanced".
 */
export function balanceByCurrency(trialBalance: TrialBalance): CurrencyBalance[] {
  return trialBalance.totals.map((total) => ({
    currency: total.currency,
    debit_minor: total.debit_minor,
    credit_minor: total.credit_minor,
    difference_minor: total.difference_minor,
    balanced: total.difference_minor === 0,
  }));
}

/** Where a journal line's reference opens in the admin, when it has a page there. */
export function referenceHref(line: {
  store_id?: string | null;
  reference_type?: string | null;
  reference_id?: string | null;
}): string | null {
  if (line.reference_type === 'order' && line.store_id && line.reference_id) {
    return `/${line.store_id}/orders/${line.reference_id}`;
  }
  return null;
}
