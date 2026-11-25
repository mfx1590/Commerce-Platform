import Link from 'next/link';
import { ApiStatePanel, EmptyPanel } from '@/components/states/state-panel';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { listMetrics, queryMetrics } from '../../_api';
import { listMetricMovers } from '../api';
import {
  breakdownOf,
  currenciesOf,
  definitionOf,
  displayUnitOf,
  formatChange,
  formatValue,
  kpisOf,
  labelOf,
  moversFor,
  parseState,
  pickCurrency,
  stateHref,
  trend,
  type BiState,
  type MetricId,
  type MetricResult,
  type Raw,
} from '../model';
import {
  breakdownQuery,
  customerFilterRefused,
  moversQuery,
  overviewQueries,
  SMALL_CELL_REFUSAL,
} from '../queries';
import { BiExport } from './bi-export';
import { BiNav, Controls, CurrencyTabs, Definition, FilterChips, Notice } from './shell';

const TREND_TONE = {
  up: 'text-success',
  down: 'text-danger',
  flat: 'text-muted',
  none: 'text-muted',
};

/** The filter key a breakdown row sets when clicked. */
const FILTER_OF = {
  store: 'store',
  country: 'country',
  sales_channel: 'channel',
  category: 'category',
} as const;

/**
 * BI v2 · Overview (#871 view 1): the revenue broken down (net sales, gross, discounts, shipping,
 * tax, refunds, net bookings), orders, units, AOV and items per order — each against the
 * comparison period — per currency (a tab; never summed), broken down by store, country, sales
 * channel or category, and "What changed" from the movers (change, never cause).
 */
export async function OverviewView({
  raw,
  base,
  storeId,
}: {
  raw: Raw;
  base: string;
  /** Set on a store's BI: every query is narrowed to it. */
  storeId?: string;
}) {
  const state: BiState = parseState(raw);
  const catalogue = await listMetrics();
  if (!catalogue.ok) {
    return <ApiStatePanel status={catalogue.status} error={catalogue.error} what="BI" />;
  }
  const effective: BiState =
    storeId !== undefined && state.by === 'store' ? { ...state, by: 'country' } : state;
  // a customer filter under a product or category filter: nothing of the overview can be protected (#951)
  if (customerFilterRefused(effective, []))
    return (
      <p role="note" className="text-muted text-sm">
        {SMALL_CELL_REFUSAL}
      </p>
    );
  const overview = overviewQueries(catalogue.data, effective, storeId);
  const breakdown = breakdownQuery(catalogue.data, effective, storeId);
  const movers = moversQuery(effective, storeId);

  const [totals, rows, change] = await Promise.all([
    Promise.all(overview.queries.map((query) => queryMetrics(query))),
    breakdown.query === null ? Promise.resolve(null) : queryMetrics(breakdown.query),
    movers === null ? Promise.resolve(null) : listMetricMovers(movers),
  ]);
  const failed = totals.find((result) => !result.ok);
  if (failed !== undefined && !failed.ok) {
    return <ApiStatePanel status={failed.status} error={failed.error} what="the overview" />;
  }
  const results = totals.flatMap((result) => (result.ok ? [result.data] : []));

  const currencies = [
    ...new Set([...results.flatMap(currenciesOf), ...(rows?.ok ? currenciesOf(rows.data) : [])]),
  ];
  const currency = pickCurrency(currencies, state.currency);
  const kpis = kpisOf(
    results,
    overview.queries.flatMap((query) => query.metrics),
    currency,
  );
  const labels = {
    ...(rows?.ok ? rows.data.labels : {}),
    ...(change?.ok ? change.data.labels : {}),
  };
  const names = (kind: string, id: string) => labelOf(labels, kind, id);
  const params: Record<string, string> = Object.fromEntries(
    Object.entries(raw).flatMap(([key, value]) =>
      typeof value === 'string' ? [[key, value]] : [],
    ),
  );
  const compared = results.find((result) => result.compare !== undefined)?.compare;
  const asOf = results[0]?.data_as_of ?? null;
  const empty = results.every(
    (result) => result.rows.length === 0 && result.currency_totals.length === 0,
  );

  return (
    <div className="space-y-6">
      <BiNav base={base} current="overview" state={state} />
      <Card>
        <CardHeader
          title="Overview"
          description={`Sales from ${state.window.from} to ${state.window.to} (UTC days, the end day excluded)${compared ? `, against ${compared.from} to ${compared.to}` : ''}.${asOf ? ` Data as of ${asOf.replace('T', ' ').slice(0, 16)} UTC.` : ''}`}
          action={
            <BiExport
              block="overview"
              params={params}
              storeId={storeId ?? null}
              what="bi-overview"
              cap={catalogue.data.max_rows}
            />
          }
        />
        <CardBody className="space-y-4">
          <Controls
            action={`${base}/overview`}
            state={effective}
            catalogue={catalogue.data}
            storeScoped={storeId !== undefined}
          />
          <FilterChips base={`${base}/overview`} state={state} names={names} />
          <CurrencyTabs
            base={`${base}/overview`}
            state={state}
            currencies={currencies}
            current={currency}
          />
          {compared?.current_incomplete && (
            <Notice tone="warning">
              The current period has not ended yet: it is compared with a full previous period, so
              it will look lower until it ends.
            </Notice>
          )}
          {overview.missing.length > 0 && (
            <Notice>
              Not offered to you by the catalogue, so not shown: {overview.missing.join(', ')}.
            </Notice>
          )}
          {empty ? (
            <EmptyPanel
              title="No sales in this period"
              description="Nothing was placed in these days with these filters. Widen the period or remove a filter."
            />
          ) : (
            <ul aria-label="Headline figures" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {kpis.map((kpi) => {
                const definition = definitionOf(catalogue.data, kpi.metric);
                const unit = displayUnitOf(definition, kpi.metric);
                const money = unit === 'minor' ? currency : null;
                return (
                  <li
                    key={kpi.metric}
                    aria-label={definition?.label ?? kpi.metric}
                    className={cn(
                      'border-line bg-surface space-y-1 rounded-lg border p-3',
                      kpi.metric === 'net_sales_minor' && 'border-accent/40',
                    )}
                  >
                    <p className="text-muted text-xs">{definition?.label ?? kpi.metric}</p>
                    <p className="text-xl font-semibold tabular-nums">
                      {formatValue(kpi.current, unit, money)}
                    </p>
                    {state.compare !== 'none' && (
                      <p className={cn('text-xs tabular-nums', TREND_TONE[trend(kpi.change)])}>
                        {formatChange(kpi.change, kpi.changeBp, unit, money)}
                        <span className="text-muted">
                          {' '}
                          vs {formatValue(kpi.previous, unit, money)}
                        </span>
                      </p>
                    )}
                    <Definition definition={definition} />
                  </li>
                );
              })}
            </ul>
          )}
        </CardBody>
      </Card>

      <Breakdown
        base={base}
        state={effective}
        result={rows?.ok ? rows.data : null}
        error={rows !== null && !rows.ok ? { status: rows.status, error: rows.error } : null}
        currency={currency}
        catalogue={catalogue.data}
        missing={breakdown.missing}
        params={params}
        storeId={storeId}
      />

      <Card>
        <CardHeader
          title="What changed"
          description="Net sales by the same breakdown, ranked by the size of the change inside this currency. It says what changed, never why."
        />
        <CardBody className="space-y-3">
          {movers === null ? (
            <p role={state.compare === 'none' ? undefined : 'note'} className="text-muted text-sm">
              {state.compare === 'none'
                ? 'Choose a comparison to see what changed.'
                : SMALL_CELL_REFUSAL}
            </p>
          ) : change === null || !change.ok ? (
            change !== null && !change.ok ? (
              <ApiStatePanel status={change.status} error={change.error} what="what changed" />
            ) : null
          ) : (
            (() => {
              const block = moversFor(change.data, currency);
              if (block === null || (block.risers.length === 0 && block.fallers.length === 0)) {
                return <p className="text-muted text-sm">Nothing moved between the two periods.</p>;
              }
              const unit = displayUnitOf(
                definitionOf(catalogue.data, 'net_sales_minor'),
                'net_sales_minor',
              );
              const list = (title: string, items: typeof block.risers) => (
                <div>
                  <h3 className="text-sm font-medium">{title}</h3>
                  {items.length === 0 ? (
                    <p className="text-muted text-xs">None.</p>
                  ) : (
                    <ul className="space-y-1 text-sm">
                      {items.map((item) => (
                        <li key={item.key} className="flex flex-wrap items-baseline gap-2">
                          <span className="font-medium">
                            {labelOf(change.data.labels, effective.by, item.key)}
                          </span>
                          <span className={cn('tabular-nums', TREND_TONE[trend(item.change)])}>
                            {formatChange(item.change, item.change_bp, unit, block.currency)}
                          </span>
                          <span className="text-muted text-xs tabular-nums">
                            {formatValue(item.previous, unit, block.currency)} →{' '}
                            {formatValue(item.current, unit, block.currency)}
                          </span>
                          {item.is_new && <Badge tone="accent">new</Badge>}
                          {item.is_gone && <Badge tone="warning">no sales now</Badge>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
              return (
                <div className="grid gap-4 md:grid-cols-2">
                  {list('Biggest rises', block.risers)}
                  {list('Biggest falls', block.fallers)}
                </div>
              );
            })()
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function Breakdown({
  base,
  state,
  result,
  error,
  currency,
  catalogue,
  missing,
  params,
  storeId,
}: {
  base: string;
  state: BiState;
  result: MetricResult | null;
  error: { status: number; error: { code: string; message: string } } | null;
  currency: string | null;
  catalogue: Parameters<typeof definitionOf>[0];
  missing: MetricId[];
  params: Record<string, string>;
  storeId: string | undefined;
}) {
  const lines = result === null ? [] : breakdownOf(result, state.by, currency);
  const metrics = (result?.query.metrics ?? []) as MetricId[];
  const ordersHref = (store: string) =>
    `/${store}/orders?placed_from=${state.window.from}T00:00:00.000Z&placed_to=${new Date(Date.parse(`${state.window.to}T00:00:00Z`) - 1).toISOString()}`;
  return (
    <Card>
      <CardHeader
        title={`By ${state.by.replace('_', ' ')}`}
        description="Click a row to filter the whole page by it."
        action={
          <BiExport
            block="breakdown"
            params={params}
            storeId={storeId ?? null}
            what={`bi-by-${state.by}`}
            cap={catalogue.max_rows}
          />
        }
      />
      <CardBody className="space-y-3">
        {missing.length > 0 && (
          <Notice>
            Not offered by {state.by}: {missing.join(', ')}.
          </Notice>
        )}
        {state.by !== 'store' && (
          <Notice>
            Drill-down to orders is per store only: the orders list has no{' '}
            {state.by.replace('_', ' ')} filter yet.
          </Notice>
        )}
        {customerFilterRefused(state, [state.by]) ? (
          <p role="note" className="text-muted text-sm">
            {SMALL_CELL_REFUSAL}
          </p>
        ) : error !== null ? (
          <ApiStatePanel status={error.status} error={error.error} what="the breakdown" />
        ) : lines.length === 0 ? (
          <p className="text-muted text-sm">No rows for this currency and these filters.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" aria-label={`Breakdown by ${state.by}`}>
              <thead className="text-muted text-left text-xs">
                <tr>
                  <th className="py-1">{state.by.replace('_', ' ')}</th>
                  {metrics.map((metric) => (
                    <th key={metric}>{definitionOf(catalogue, metric)?.label ?? metric}</th>
                  ))}
                  {state.by === 'store' && <th />}
                </tr>
              </thead>
              <tbody className="divide-line divide-y">
                {lines.map((line) => (
                  <tr key={line.key}>
                    <td className="py-2">
                      <Link
                        href={stateHref(`${base}/overview`, state, {
                          [FILTER_OF[state.by]]: line.key,
                        })}
                        className="text-accent hover:underline"
                        aria-label={`Filter by ${line.label}`}
                      >
                        {line.label}
                      </Link>
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
                    {state.by === 'store' && (
                      <td className="text-right">
                        <Link
                          href={ordersHref(line.key)}
                          className="text-accent text-xs hover:underline"
                          aria-label={`Orders of ${line.label} in this period`}
                        >
                          Orders →
                        </Link>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {result?.truncated && (
          <Notice tone="warning">
            Only the first rows are shown: the answer was cut at its row limit.
          </Notice>
        )}
      </CardBody>
    </Card>
  );
}
