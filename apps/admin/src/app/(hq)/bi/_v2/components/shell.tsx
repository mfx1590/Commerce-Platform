import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { CopyLink } from './copy-link';
import {
  BREAKDOWNS,
  CUSTOMER_TYPES,
  describeState,
  stateHref,
  type BiState,
  type MetricCatalogue,
  type MetricDefinition,
} from '../model';

/**
 * The frame every BI v2 view shares (#871): the section tabs, the controls (period, comparison,
 * filters — each usable without editing the URL), the active filters as removable chips, the
 * currency tabs, and a metric's written definition from the catalogue.
 */

export type BiView = 'dashboard' | 'overview' | 'products' | 'inventory';

const VIEWS: { id: BiView; label: string; path: string }[] = [
  // Inventory health first: it answers the owner's question, "do we need to order anything?".
  { id: 'inventory', label: 'Inventory health', path: '/inventory' },
  { id: 'overview', label: 'Overview', path: '/overview' },
  { id: 'products', label: 'Products & categories', path: '/products' },
  { id: 'dashboard', label: 'Dashboard', path: '' },
];

export function BiNav({
  base,
  current,
  state,
  copyLink = true,
}: {
  base: string;
  current: BiView;
  state: BiState;
  /** Off on the existing dashboards: their URL holds their own parameters, not this model's. */
  copyLink?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-4">
      <nav aria-label="BI views" className="flex flex-wrap gap-4 text-sm">
        {VIEWS.map((view) => (
          <Link
            key={view.id}
            href={
              view.id === 'dashboard'
                ? `${base}${view.path}`
                : stateHref(`${base}${view.path}`, state)
            }
            aria-current={view.id === current ? 'page' : undefined}
            className={view.id === current ? 'font-semibold' : 'text-accent hover:underline'}
          >
            {view.label}
          </Link>
        ))}
      </nav>
      {copyLink && <CopyLink />}
    </div>
  );
}

const COMPARE_WORDS = {
  previous_period: 'Previous period',
  previous_year: 'Same period last year',
  none: 'No comparison',
} as const;

const BREAKDOWN_WORDS = {
  store: 'Store',
  country: 'Country',
  sales_channel: 'Sales channel',
  category: 'Category',
} as const;

/**
 * Period, comparison, breakdown and the filters a person can choose from a list or type. Channel,
 * category and product filters are set by clicking a row (the BI API offers no list of them) and
 * removed from the chips below.
 */
export function Controls({
  action,
  state,
  catalogue,
  storeScoped,
  showBreakdown = true,
  hidden = {},
}: {
  action: string;
  state: BiState;
  catalogue: MetricCatalogue;
  storeScoped: boolean;
  showBreakdown?: boolean;
  /** Extra state carried through the form (inventory sort and status, product rank). */
  hidden?: Record<string, string>;
}) {
  const keep: Record<string, string> = {
    currency: state.currency,
    channel: state.channel,
    category: state.category,
    product: state.product,
    ...hidden,
  };
  return (
    <form
      method="get"
      action={action}
      aria-label="Period and filters"
      className="flex flex-wrap items-end gap-3 text-sm"
    >
      {Object.entries(keep)
        .filter(([, value]) => value !== '')
        .map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
      <label className="flex flex-col gap-1">
        <span className="text-muted text-xs">From (UTC day)</span>
        <input
          type="date"
          name="from"
          defaultValue={state.window.from}
          className="border-line bg-surface h-9 rounded-md border px-2"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-muted text-xs">To (exclusive)</span>
        <input
          type="date"
          name="to"
          defaultValue={state.window.to}
          className="border-line bg-surface h-9 rounded-md border px-2"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-muted text-xs">Compare with</span>
        <select
          name="compare"
          defaultValue={state.compare}
          className="border-line bg-surface h-9 rounded-md border px-2"
        >
          {(Object.keys(COMPARE_WORDS) as (keyof typeof COMPARE_WORDS)[]).map((mode) => (
            <option key={mode} value={mode}>
              {COMPARE_WORDS[mode]}
            </option>
          ))}
        </select>
      </label>
      {showBreakdown && (
        <label className="flex flex-col gap-1">
          <span className="text-muted text-xs">Break down by</span>
          <select
            name="by"
            defaultValue={state.by}
            className="border-line bg-surface h-9 rounded-md border px-2"
          >
            {BREAKDOWNS.filter((by) => !(storeScoped && by === 'store')).map((by) => (
              <option key={by} value={by}>
                {BREAKDOWN_WORDS[by]}
              </option>
            ))}
          </select>
        </label>
      )}
      {!storeScoped && catalogue.stores.length > 1 && (
        <label className="flex flex-col gap-1">
          <span className="text-muted text-xs">Store</span>
          <select
            name="store"
            defaultValue={state.store}
            className="border-line bg-surface h-9 rounded-md border px-2"
          >
            <option value="">All my stores</option>
            {catalogue.stores.map((store) => (
              <option key={store.id} value={store.id}>
                {store.code}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-muted text-xs">Country (ISO, e.g. JP)</span>
        <input
          name="country"
          defaultValue={state.country}
          maxLength={2}
          className="border-line bg-surface h-9 w-24 rounded-md border px-2 uppercase"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-muted text-xs">Customers</span>
        <select
          name="customer"
          defaultValue={state.customer}
          className="border-line bg-surface h-9 rounded-md border px-2"
        >
          <option value="">All</option>
          {CUSTOMER_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="bg-accent text-accent-ink h-9 rounded-md px-3">
        Apply
      </button>
    </form>
  );
}

/** The active filters, each removable; what the figures below are filtered by, in words. */
export function FilterChips({
  base,
  state,
  names,
  extra = {},
}: {
  base: string;
  state: BiState;
  names: (kind: string, id: string) => string;
  extra?: Record<string, string>;
}) {
  const chips: {
    key: 'store' | 'country' | 'channel' | 'category' | 'product' | 'customer';
    text: string;
  }[] = [];
  if (state.store) chips.push({ key: 'store', text: `Store: ${names('store', state.store)}` });
  if (state.country) chips.push({ key: 'country', text: `Country: ${state.country}` });
  if (state.channel)
    chips.push({ key: 'channel', text: `Channel: ${names('sales_channel', state.channel)}` });
  if (state.category)
    chips.push({ key: 'category', text: `Category: ${names('category', state.category)}` });
  if (state.product)
    chips.push({ key: 'product', text: `Product: ${names('product', state.product)}` });
  if (state.customer) chips.push({ key: 'customer', text: `Customers: ${state.customer}` });
  if (chips.length === 0)
    return <p className="text-muted text-xs">No filter: every store you can see.</p>;
  return (
    <ul aria-label="Active filters" className="flex flex-wrap gap-2 text-xs">
      {chips.map((chip) => (
        <li
          key={chip.key}
          className="border-line bg-canvas flex items-center gap-1 rounded-full border px-2 py-0.5"
        >
          {chip.text}
          <Link
            href={stateHref(base, state, { [chip.key]: '' }, extra)}
            aria-label={`Remove the filter ${chip.text}`}
            className="text-muted hover:text-ink"
          >
            ×
          </Link>
        </li>
      ))}
      <li className="sr-only">{describeState(state, names)}</li>
    </ul>
  );
}

/** One tab per currency: every figure under it belongs to that currency only. */
export function CurrencyTabs({
  base,
  state,
  currencies,
  current,
  extra = {},
}: {
  base: string;
  state: BiState;
  currencies: readonly string[];
  current: string | null;
  extra?: Record<string, string>;
}) {
  if (currencies.length <= 1) return null;
  return (
    <nav aria-label="Currency" className="flex gap-3 text-sm">
      {currencies.map((currency) => (
        <Link
          key={currency}
          href={stateHref(base, state, { currency }, extra)}
          aria-current={currency === current ? 'page' : undefined}
          className={cn(
            'rounded-md px-2 py-0.5',
            currency === current
              ? 'bg-accent/10 text-accent font-semibold'
              : 'text-muted hover:underline',
          )}
        >
          {currency}
        </Link>
      ))}
      <span className="text-muted self-center text-xs">
        Amounts are never added across currencies.
      </span>
    </nav>
  );
}

/** The catalogue's written definition of a metric (and its formula), for the person reading it. */
export function Definition({ definition }: { definition: MetricDefinition | undefined }) {
  if (definition === undefined) return null;
  return (
    <details className="text-muted text-xs">
      <summary className="cursor-pointer">How is this measured?</summary>
      <p className="mt-1">{definition.description}</p>
      {definition.formula ? <p className="mt-1 font-mono">{definition.formula}</p> : null}
    </details>
  );
}

/** A plain notice line (degraded data, truncated answers, what the page cannot show). */
export function Notice({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'warning';
  children: ReactNode;
}) {
  return (
    <p
      role="note"
      className={cn(
        'rounded-md border px-3 py-2 text-sm',
        tone === 'warning' ? 'border-warning/30 bg-warning/5' : 'border-line bg-canvas',
      )}
    >
      {children}
    </p>
  );
}
