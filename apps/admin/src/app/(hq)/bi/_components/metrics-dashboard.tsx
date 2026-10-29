/**
 * The BI v2 dashboard over the metrics API (#604), shared by HQ `/bi` (every store the principal may see) and the
 * store view `/<storeId>/bi` (that store only). The API decides access: the page narrows, the server scopes.
 *
 * - Live tiles (polled), then per currency tab: KPIs, bookings and refunds per day per store, the money views
 *   (bookings vs recognised vs cash) for finance principals only, top products, and a CSV download.
 * - Money is never added across currencies: every figure below the tabs belongs to the selected currency.
 */
import { ApiStatePanel } from '@/components/states/state-panel';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { formatMoney } from '@/lib/forms/money';
import { queryMetrics } from '../_api';
import {
  currencies,
  forStore,
  liveQuery,
  moneyViews,
  moneyViewsQuery,
  periodQuery,
  rateLabel,
  storeSeries,
  topProductsQuery,
  totalsOf,
  type MetricResult,
} from '../_lib/metrics';
import {
  biHref,
  daysOf,
  pickCurrency,
  storeColors,
  storeLabel,
  type ReportWindow,
  type StoreRef,
} from '../_lib/report';
import { LiveTiles } from './live-tiles';
import { SeriesChart, type ChartSeries } from './series-chart';

export async function MetricsDashboard({
  window,
  currencyParam,
  finance,
  stores,
  storeId,
  base,
}: {
  window: ReportWindow;
  currencyParam: string | undefined;
  /** The principal holds `finance` on organization:hq: only then are finance metrics asked for (else a 403). */
  finance: boolean;
  stores: readonly StoreRef[];
  /** Set in the store view: every query is narrowed to this store. */
  storeId?: string;
  /** `/bi` or `/<storeId>/bi`: links, the live poll and the CSV download hang off it. */
  base: string;
}) {
  const narrow = <Q extends Parameters<typeof forStore>[0]>(q: Q) => forStore(q, storeId);
  const [period, top, money, live] = await Promise.all([
    queryMetrics(narrow(periodQuery(window))),
    queryMetrics(narrow(topProductsQuery(window))),
    finance ? queryMetrics(narrow(moneyViewsQuery(window))) : Promise.resolve(null),
    queryMetrics(narrow(liveQuery())),
  ]);
  const codeOf = (id: string) => storeLabel(stores, id);
  const labels = Object.fromEntries(stores.map((s) => [s.store_id, s.code]));

  return (
    <Card>
      <CardHeader
        title={storeId ? 'Store metrics' : 'Metrics'}
        description={`From the analytics store, ${window.from} to ${window.to} (UTC, end exclusive). One currency at a time.`}
      />
      <CardBody className="space-y-6">
        {live.ok ? (
          <LiveTiles initial={live.data} endpoint={`${base}/live`} labels={labels} />
        ) : (
          <ApiStatePanel
            status={live.status}
            error={live.error}
            what="live metrics"
            hint="Live figures come from the analytics store; it may be catching up."
          />
        )}
        {!period.ok ? (
          <ApiStatePanel
            status={period.status}
            error={period.error}
            what="metrics"
            hint="The metrics API answers 503 while the analytics store is unavailable; nothing partial is shown."
          />
        ) : (
          <PeriodSection
            result={period.data}
            top={top.ok ? top.data : null}
            money={money?.ok ? money.data : null}
            finance={finance}
            window={window}
            currencyParam={currencyParam}
            stores={stores}
            codeOf={codeOf}
            base={base}
          />
        )}
      </CardBody>
    </Card>
  );
}

function PeriodSection({
  result,
  top,
  money,
  finance,
  window,
  currencyParam,
  stores,
  codeOf,
  base,
}: {
  result: MetricResult;
  top: MetricResult | null;
  money: MetricResult | null;
  finance: boolean;
  window: ReportWindow;
  currencyParam: string | undefined;
  stores: readonly StoreRef[];
  codeOf: (id: string) => string;
  base: string;
}) {
  const tabs = currencies(result);
  const currency = pickCurrency(tabs, currencyParam);
  const exportHref = `${base}/export?${new URLSearchParams({ from: window.from, to: window.to })}`;
  if (currency === null)
    return (
      <div className="flex items-center justify-between">
        <p className="text-muted text-sm">No orders in this window.</p>
        <a className="text-accent text-sm underline" href={exportHref} download>
          Download CSV
        </a>
      </div>
    );

  const fmt = (v: number) => formatMoney(v, currency);
  const totals = totalsOf(result, currency);
  const days = daysOf(window);
  const colors = storeColors([...stores]);
  const chart = (metric: 'bookings_minor' | 'refunds_minor'): ChartSeries[] =>
    storeSeries(result, metric, currency, days)
      .sort((a, b) => codeOf(a.storeId).localeCompare(codeOf(b.storeId)))
      .map((s) => ({
        id: s.storeId,
        label: codeOf(s.storeId),
        // a store outside the principal's list (never expected: the server scopes) still gets drawn, in grey
        color: colors.get(s.storeId) ?? 'var(--color-muted)',
        values: s.values,
      }));
  const views = money ? moneyViews(money, finance).find((v) => v.currency === currency) : undefined;
  const products = (top?.rows ?? []).filter((r) => r.currency === currency && r.product_id);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <nav aria-label="Metrics currency" className="border-line flex gap-1 border-b">
          {tabs.map((c) => (
            <a
              key={c}
              href={biHref(window, { currency: c }, base)}
              aria-current={c === currency ? 'page' : undefined}
              className={
                c === currency
                  ? 'border-accent text-ink -mb-px border-b-2 px-3 py-2 font-mono text-sm'
                  : 'text-muted hover:text-ink px-3 py-2 font-mono text-sm'
              }
            >
              {c}
            </a>
          ))}
        </nav>
        <a className="text-accent text-sm underline" href={exportHref} download>
          Download CSV
        </a>
      </div>
      {result.truncated && (
        <p className="text-sm text-amber-300">
          The answer was cut at the row limit: narrow the window for every row.
        </p>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Kpi label="Bookings" value={fmt(totals.bookings_minor ?? 0)} />
        <Kpi label="Refunds" value={fmt(totals.refunds_minor ?? 0)} />
        <Kpi label="Refund rate" value={rateLabel(totals.refund_rate_bp)} />
      </div>
      <SeriesChart
        title={`Bookings per day (${currency})`}
        days={days}
        series={chart('bookings_minor')}
        format={fmt}
      />
      <SeriesChart
        title={`Refunds per day (${currency})`}
        days={days}
        series={chart('refunds_minor')}
        format={fmt}
      />
      {views && (
        <table className="w-full text-sm" data-testid="bi-money-views">
          <caption className="text-muted mb-2 text-left text-xs">
            Three views of the same money, {currency}: bookings (orders placed), recognised (the
            ledger) and cash (captured). They differ by timing and refunds, never by addition.
          </caption>
          <thead className="text-muted text-xs uppercase">
            <tr className="border-line border-b">
              <th className="py-2 text-right font-medium">Bookings</th>
              <th className="py-2 text-right font-medium">Recognised</th>
              <th className="py-2 text-right font-medium">Cash</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="py-2 text-right font-mono tabular-nums">
                {fmt(views.bookings_minor)}
              </td>
              <td className="py-2 text-right font-mono tabular-nums">
                {fmt(views.recognised_minor ?? 0)}
              </td>
              <td className="py-2 text-right font-mono tabular-nums">
                {fmt(views.captured_minor ?? 0)}
              </td>
            </tr>
          </tbody>
        </table>
      )}
      {products.length > 0 && (
        <table className="w-full text-sm">
          <caption className="text-muted mb-2 text-left text-xs">
            Top products by units, {currency}.
          </caption>
          <thead className="text-muted text-xs uppercase">
            <tr className="border-line border-b">
              <th className="py-2 text-left font-medium">Product</th>
              <th className="py-2 text-right font-medium">Units</th>
              <th className="py-2 text-right font-medium">Net</th>
            </tr>
          </thead>
          <tbody className="divide-line divide-y">
            {products.map((r) => (
              <tr key={r.product_id}>
                <td className="py-2 font-mono text-xs">{r.product_id}</td>
                <td className="py-2 text-right font-mono tabular-nums">{r.values.units ?? 0}</td>
                <td className="py-2 text-right font-mono tabular-nums">
                  {fmt(r.values.product_net_minor ?? 0)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-line rounded border px-4 py-3">
      <p className="text-muted text-xs uppercase">{label}</p>
      <p className="mt-1 font-mono text-lg tabular-nums">{value}</p>
    </div>
  );
}
