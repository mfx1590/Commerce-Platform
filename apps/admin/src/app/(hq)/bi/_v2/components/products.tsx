import Link from 'next/link';
import { ApiStatePanel } from '@/components/states/state-panel';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { listMetrics, queryMetrics } from '../../_api';
import { getInventoryHealth } from '../api';
import {
  breakdownOf,
  currenciesOf,
  definitionOf,
  displayUnitOf,
  formatChange,
  formatValue,
  labelOf,
  parseState,
  pickCurrency,
  stateHref,
  trend,
  type BiState,
  type MetricCatalogue,
  type MetricId,
  type MetricResult,
  type Raw,
} from '../model';
import { categoriesQuery, PRODUCT_RANKS, productsQuery, type ProductRank } from '../queries';
import { BiExport } from './bi-export';
import { BiNav, Controls, CurrencyTabs, Definition, FilterChips, Notice } from './shell';

const TREND_TONE = {
  up: 'text-success',
  down: 'text-danger',
  flat: 'text-muted',
  none: 'text-muted',
};

const RANK_WORDS: Record<ProductRank, string> = {
  product_net_ex_tax_minor: 'net sales',
  units: 'units sold',
  product_return_rate_bp: 'return rate',
};

const one = (raw: Raw, key: string) => {
  const v = raw[key];
  return (Array.isArray(v) ? v[0] : v) ?? '';
};

/**
 * BI v2 · Products & categories (#871 view 2): best and worst products by net sales, units or
 * return rate — by NAME (the answer's labels), never an id — the category roll-up, and the items
 * with stock but no sales (inventory health `dead`). Per currency; never summed.
 */
export async function ProductsView({
  raw,
  base,
  storeId,
}: {
  raw: Raw;
  base: string;
  storeId?: string;
}) {
  const state: BiState = parseState(raw);
  const rank: ProductRank = (PRODUCT_RANKS as readonly string[]).includes(one(raw, 'rank'))
    ? (one(raw, 'rank') as ProductRank)
    : 'product_net_ex_tax_minor';
  const catalogue = await listMetrics();
  if (!catalogue.ok)
    return <ApiStatePanel status={catalogue.status} error={catalogue.error} what="BI" />;

  const best = productsQuery(catalogue.data, state, rank, 'desc', storeId);
  const worst = productsQuery(catalogue.data, state, rank, 'asc', storeId);
  const categories = categoriesQuery(catalogue.data, state, storeId);
  const [bestR, worstR, categoriesR, dead] = await Promise.all([
    best.query === null ? null : queryMetrics(best.query),
    worst.query === null ? null : queryMetrics(worst.query),
    categories.query === null ? null : queryMetrics(categories.query),
    getInventoryHealth({
      ...((storeId ?? state.store) ? { store_ids: [storeId ?? state.store] } : {}),
      ...(state.category ? { category_ids: [state.category] } : {}),
      status: ['dead'],
      sort: 'available',
      direction: 'desc',
      page: 1,
      limit: 10,
    }),
  ]);

  const answers = [bestR, worstR, categoriesR].flatMap((r) => (r?.ok ? [r.data] : []));
  const currencies = [...new Set(answers.flatMap(currenciesOf))];
  const currency = pickCurrency(currencies, state.currency);
  const labels = Object.assign({}, ...answers.map((a) => a.labels ?? {}));
  const names = (kind: string, id: string) => labelOf(labels, kind, id);
  const params: Record<string, string> = Object.fromEntries(
    Object.entries(raw).flatMap(([key, value]) =>
      typeof value === 'string' ? [[key, value]] : [],
    ),
  );
  const view = `${base}/products`;

  return (
    <div className="space-y-6">
      <BiNav base={base} current="products" state={state} />
      <Card>
        <CardHeader
          title="Products & categories"
          description={`From ${state.window.from} to ${state.window.to} (UTC days, the end day excluded). Products are named as they are now; a deleted one shows "(deleted)".`}
        />
        <CardBody className="space-y-4">
          <Controls
            action={view}
            state={state}
            catalogue={catalogue.data}
            storeScoped={storeId !== undefined}
            showBreakdown={false}
            hidden={{ rank }}
          />
          <FilterChips base={view} state={state} names={names} extra={{ rank }} />
          <CurrencyTabs
            base={view}
            state={state}
            currencies={currencies}
            current={currency}
            extra={{ rank }}
          />
          <nav aria-label="Rank products by" className="flex gap-3 text-sm">
            <span className="text-muted">Rank by:</span>
            {PRODUCT_RANKS.map((r) => (
              <Link
                key={r}
                href={stateHref(view, state, {}, { rank: r })}
                aria-current={r === rank ? 'page' : undefined}
                className={r === rank ? 'font-semibold' : 'text-accent hover:underline'}
              >
                {RANK_WORDS[r]}
              </Link>
            ))}
          </nav>
          <Definition definition={definitionOf(catalogue.data, rank)} />
          {best.missing.length > 0 && (
            <Notice>Not offered by product: {best.missing.join(', ')}.</Notice>
          )}
        </CardBody>
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        <ProductTable
          title={`Best by ${RANK_WORDS[rank]}`}
          answer={bestR}
          state={state}
          view={view}
          rank={rank}
          currency={currency}
          catalogue={catalogue.data}
          storeId={storeId}
          exportBlock={
            <BiExport
              block="products"
              params={{ ...params, rank, dir: 'desc' }}
              storeId={storeId ?? null}
              what="bi-products-best"
              cap={catalogue.data.max_rows}
            />
          }
        />
        <ProductTable
          title={`Worst by ${RANK_WORDS[rank]}`}
          answer={worstR}
          state={state}
          view={view}
          rank={rank}
          currency={currency}
          catalogue={catalogue.data}
          storeId={storeId}
          exportBlock={
            <BiExport
              block="products"
              params={{ ...params, rank, dir: 'asc' }}
              storeId={storeId ?? null}
              what="bi-products-worst"
              cap={catalogue.data.max_rows}
            />
          }
        />
      </div>
      <p className="text-muted text-xs">
        &quot;Worst&quot; lists products that sold in the period; a product with no sale at all is
        under &quot;Stock but no sales&quot; below.
      </p>

      <Card>
        <CardHeader
          title="By category"
          description="The same measures rolled up per category."
          action={
            <BiExport
              block="categories"
              params={params}
              storeId={storeId ?? null}
              what="bi-categories"
              cap={catalogue.data.max_rows}
            />
          }
        />
        <CardBody>
          <RowsTable
            answer={categoriesR}
            dimension="category"
            state={state}
            view={view}
            currency={currency}
            catalogue={catalogue.data}
            filterKey="category"
            extra={{ rank }}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Stock but no sales"
          description="Items with stock that sold nothing in the dead-stock window (inventory health status “dead”), largest stock first."
        />
        <CardBody className="space-y-2">
          {!dead.ok ? (
            <ApiStatePanel status={dead.status} error={dead.error} what="stock without sales" />
          ) : !dead.data.rate_available ? (
            <Notice tone="warning">
              Sales rates are unavailable right now, so items without sales cannot be found. Stock
              positions are still live on Inventory health.
            </Notice>
          ) : dead.data.rows.length === 0 ? (
            <p className="text-muted text-sm">
              Every item with stock sold something in the window.
            </p>
          ) : (
            <table className="w-full text-sm" aria-label="Stock but no sales">
              <thead className="text-muted text-left text-xs">
                <tr>
                  <th className="py-1">Item</th>
                  <th>Available</th>
                  <th>Last sale</th>
                  <th>Window (days)</th>
                </tr>
              </thead>
              <tbody className="divide-line divide-y">
                {dead.data.rows.map((row) => (
                  <tr key={row.stock_item_id}>
                    <td className="py-2">
                      {row.name} <span className="text-muted font-mono text-xs">{row.sku}</span>
                    </td>
                    <td className="tabular-nums">{row.available}</td>
                    <td className="text-muted text-xs">
                      {row.last_sale_at ? row.last_sale_at.slice(0, 10) : 'never'}
                    </td>
                    <td className="tabular-nums">{row.parameters.dead_days}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {dead.ok && dead.data.total > dead.data.rows.length && (
            <p className="text-muted text-xs">
              {dead.data.total} items in all —{' '}
              <Link
                href={stateHref(`${base}/inventory`, state, {}, { status: 'dead' })}
                className="text-accent hover:underline"
              >
                see them all on Inventory health
              </Link>
              .
            </p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function ProductTable({
  title,
  answer,
  state,
  view,
  rank,
  currency,
  catalogue,
  storeId,
  exportBlock,
}: {
  title: string;
  answer: Awaited<ReturnType<typeof queryMetrics>> | null;
  state: BiState;
  view: string;
  rank: ProductRank;
  currency: string | null;
  catalogue: MetricCatalogue;
  storeId: string | undefined;
  exportBlock: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader title={title} action={exportBlock} />
      <CardBody>
        <RowsTable
          answer={answer}
          dimension="product"
          state={state}
          view={view}
          currency={currency}
          catalogue={catalogue}
          filterKey="product"
          extra={{ rank }}
          catalogHref={storeId ? (id) => `/${storeId}/catalog/${id}` : undefined}
        />
      </CardBody>
    </Card>
  );
}

function RowsTable({
  answer,
  dimension,
  state,
  view,
  currency,
  catalogue,
  filterKey,
  extra,
  catalogHref,
}: {
  answer: Awaited<ReturnType<typeof queryMetrics>> | null;
  dimension: 'product' | 'category';
  state: BiState;
  view: string;
  currency: string | null;
  catalogue: MetricCatalogue;
  filterKey: 'product' | 'category';
  extra: Record<string, string>;
  catalogHref?: ((id: string) => string) | undefined;
}) {
  if (answer === null)
    return <p className="text-muted text-sm">Not offered by {dimension} in the catalogue.</p>;
  if (!answer.ok)
    return (
      <ApiStatePanel status={answer.status} error={answer.error} what={`the ${dimension} table`} />
    );
  const result: MetricResult = answer.data;
  const lines = breakdownOf(result, dimension, currency);
  const metrics = result.query.metrics as MetricId[];
  if (lines.length === 0)
    return <p className="text-muted text-sm">No sales for this currency and these filters.</p>;
  return (
    <div className="space-y-2 overflow-x-auto">
      <table className="w-full text-sm" aria-label={`By ${dimension}`}>
        <thead className="text-muted text-left text-xs">
          <tr>
            <th className="py-1">{dimension}</th>
            {metrics.map((metric) => (
              <th key={metric}>{definitionOf(catalogue, metric)?.label ?? metric}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-line divide-y">
          {lines.map((line) => (
            <tr key={line.key}>
              <td className="py-2">
                <Link
                  href={stateHref(view, state, { [filterKey]: line.key }, extra)}
                  className="text-accent hover:underline"
                  aria-label={`Filter by ${line.label}`}
                >
                  {line.label}
                </Link>
                {catalogHref && (
                  <Link
                    href={catalogHref(line.key)}
                    className="text-muted ml-2 text-xs hover:underline"
                    aria-label={`Open ${line.label} in the catalog`}
                  >
                    open
                  </Link>
                )}
              </td>
              {metrics.map((metric) => {
                const unit = displayUnitOf(definitionOf(catalogue, metric), metric);
                const money = unit === 'minor' ? currency : null;
                const now = line.values[metric] ?? null;
                const before = line.previous[metric] ?? null;
                return (
                  <td key={metric} className="tabular-nums">
                    {formatValue(now, unit, money)}
                    {state.compare !== 'none' && now !== null && before !== null && (
                      <span className={cn('block text-xs', TREND_TONE[trend(now - before)])}>
                        {formatChange(
                          now - before,
                          unit === 'percent' || before === 0
                            ? null
                            : Math.round(((now - before) / before) * 10000),
                          unit,
                          money,
                        )}
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {result.truncated && (
        <Notice tone="warning">
          Only the first rows are shown: the answer was cut at its row limit.
        </Notice>
      )}
    </div>
  );
}
