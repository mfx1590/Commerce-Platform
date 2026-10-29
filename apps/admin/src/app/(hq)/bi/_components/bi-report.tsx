/**
 * The BI report body (#480): rendered by page.tsx inside the section guard, so nothing here runs for a principal
 * without `analyst`. The metrics dashboard (#604) first, then the v1 reports: sales per currency tab, finance only
 * for finance principals, stock per store.
 */
import { ApiStatePanel } from '@/components/states/state-panel';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { formatMoney } from '@/lib/forms/money';
import { expandOrganizationRelations } from '@/lib/nav/relations';
import { loadPrincipal } from '@/lib/principal';
import {
  getHqFinanceReport,
  getHqSalesReport,
  getStoreStockReport,
  type FinanceReport,
  type SalesReport,
  type StockReport,
} from '../_api';
import { MetricsDashboard } from './metrics-dashboard';
import { SeriesChart, type ChartSeries } from './series-chart';
import {
  biHref,
  currencyTabs,
  mergeCurrencyTabs,
  storeLabel,
  dailySeries,
  daysOf,
  pickCurrency,
  storeColors,
  windowFrom,
  type ReportWindow,
  type StoreRef,
} from '../_lib/report';

export type BiParams = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export async function BiReport({ params }: { params: BiParams }) {
  const principal = await loadPrincipal();
  const stores: StoreRef[] = principal.ok
    ? principal.data.stores.map((s) => ({ store_id: s.store_id, code: s.code }))
    : [];
  const canFinance =
    principal.ok &&
    expandOrganizationRelations(principal.data.organization_relations).has('finance');
  const window = windowFrom({ from: one(params.from), to: one(params.to) });
  const colors = storeColors(stores);
  const codeOf = (id: string) => storeLabel(stores, id);
  const byCode = [...stores].sort((a, b) => a.code.localeCompare(b.code));
  const stockStore =
    byCode.find((s) => s.store_id === one(params.stock))?.store_id ?? byCode[0]?.store_id;

  const [sales, finance, stock] = await Promise.all([
    getHqSalesReport(window),
    canFinance ? getHqFinanceReport(window) : Promise.resolve(null),
    stockStore ? getStoreStockReport(stockStore) : Promise.resolve(null),
  ]);

  const tabs = mergeCurrencyTabs(
    sales.ok ? currencyTabs(sales.data.currency_totals) : [],
    finance?.ok ? finance.data.currency_totals.map((t) => t.currency) : [],
  );
  const currency = pickCurrency(tabs, one(params.currency));

  return (
    <div className="space-y-4">
      <MetricsDashboard
        window={window}
        currencyParam={one(params.currency)}
        finance={canFinance}
        stores={stores}
        base="/bi"
      />
      <Card>
        <CardHeader
          title="BI"
          description={`Sales per store, ${window.from} to ${window.to} (UTC, end exclusive). One currency at a time — amounts are never added across currencies.`}
        />
        <CardBody className="space-y-4">
          {!sales.ok ? (
            <ApiStatePanel
              status={sales.status}
              error={sales.error}
              what="sales report"
              hint="The HQ sales report needs the analyst relation on the organization."
            />
          ) : currency === null ? (
            <p className="text-muted text-sm">No sales in this window.</p>
          ) : (
            <>
              <CurrencyTabs tabs={tabs} current={currency} window={window} stock={stockStore} />
              {sales.data.currency_totals.every((t) => t.currency !== currency) ? (
                <p className="text-muted text-sm">
                  No sales in {currency} in this window; the finance figures below are the only ones
                  in it.
                </p>
              ) : (
                <SalesSection
                  report={sales.data}
                  currency={currency}
                  window={window}
                  colors={colors}
                  codeOf={codeOf}
                />
              )}
            </>
          )}
        </CardBody>
      </Card>

      {finance !== null && <FinanceCard result={finance} currency={currency} codeOf={codeOf} />}

      <StockCard
        result={stock}
        stores={byCode}
        current={stockStore}
        window={window}
        currency={currency}
      />
    </div>
  );
}

function CurrencyTabs({
  tabs,
  current,
  window,
  stock,
}: {
  tabs: string[];
  current: string;
  window: ReportWindow;
  stock: string | undefined;
}) {
  return (
    <nav aria-label="Currency" className="border-line flex gap-1 border-b">
      {tabs.map((c) => (
        <a
          key={c}
          href={biHref(window, { currency: c, stock })}
          aria-current={c === current ? 'page' : undefined}
          className={
            c === current
              ? 'border-accent text-ink -mb-px border-b-2 px-3 py-2 font-mono text-sm'
              : 'text-muted hover:text-ink px-3 py-2 font-mono text-sm'
          }
        >
          {c}
        </a>
      ))}
    </nav>
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

function SalesSection({
  report,
  currency,
  window,
  colors,
  codeOf,
}: {
  report: SalesReport;
  currency: string;
  window: ReportWindow;
  colors: Map<string, string | null>;
  codeOf: (id: string) => string;
}) {
  const money = (v: number) => formatMoney(v, currency);
  const total = report.currency_totals.find((t) => t.currency === currency);
  const rows = report.totals
    .filter((t) => t.currency === currency)
    .sort((a, b) => codeOf(a.store_id).localeCompare(codeOf(b.store_id)));
  const days = daysOf(window);
  const toChart = (measure: 'net_minor' | 'orders'): ChartSeries[] =>
    dailySeries(report.rows, currency, days, measure)
      .filter((s) => colors.get(s.storeId))
      .sort((a, b) => codeOf(a.storeId).localeCompare(codeOf(b.storeId)))
      .map((s) => ({
        id: s.storeId,
        label: codeOf(s.storeId),
        color: colors.get(s.storeId)!,
        values: s.values,
      }));

  return (
    <div className="space-y-6">
      {total && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Kpi label="Orders" value={String(total.orders)} />
          <Kpi label="Total" value={money(total.total_minor)} />
          <Kpi label="Refunded" value={money(total.refunded_minor)} />
          <Kpi label="Net" value={money(total.net_minor)} />
        </div>
      )}
      <SeriesChart
        title={`Net revenue per day (${currency})`}
        days={days}
        series={toChart('net_minor')}
        format={money}
      />
      <SeriesChart
        title={`Orders per day (${currency})`}
        days={days}
        series={toChart('orders')}
        format={(v) => String(v)}
      />
      <table className="w-full text-sm">
        <caption className="text-muted mb-2 text-left text-xs">
          Per store, {currency}. Net = total − succeeded refunds of these orders (refunds counted on
          the order&apos;s day).
        </caption>
        <thead className="text-muted text-xs uppercase">
          <tr className="border-line border-b">
            <th className="py-2 text-left font-medium">Store</th>
            <th className="py-2 text-right font-medium">Orders</th>
            <th className="py-2 text-right font-medium">Gross</th>
            <th className="py-2 text-right font-medium">Discount</th>
            <th className="py-2 text-right font-medium">Shipping</th>
            <th className="py-2 text-right font-medium">Tax</th>
            <th className="py-2 text-right font-medium">Refunded</th>
            <th className="py-2 text-right font-medium">Net</th>
          </tr>
        </thead>
        <tbody className="divide-line divide-y">
          {rows.map((r) => (
            <tr key={r.store_id}>
              <td className="py-2 font-mono text-xs">{codeOf(r.store_id)}</td>
              <td className="py-2 text-right font-mono tabular-nums">{r.orders}</td>
              <td className="py-2 text-right font-mono tabular-nums">{money(r.gross_minor)}</td>
              <td className="py-2 text-right font-mono tabular-nums">{money(r.discount_minor)}</td>
              <td className="py-2 text-right font-mono tabular-nums">{money(r.shipping_minor)}</td>
              <td className="py-2 text-right font-mono tabular-nums">{money(r.tax_minor)}</td>
              <td className="py-2 text-right font-mono tabular-nums">{money(r.refunded_minor)}</td>
              <td className="py-2 text-right font-mono tabular-nums">{money(r.net_minor)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FinanceCard({
  result,
  currency,
  codeOf,
}: {
  result: Awaited<ReturnType<typeof getHqFinanceReport>>;
  currency: string | null;
  codeOf: (id: string) => string;
}) {
  return (
    <Card>
      <CardHeader
        title="Finance"
        description="Captured payments by capture day and succeeded refunds by refund day (cash view)."
      />
      <CardBody>
        {!result.ok ? (
          <ApiStatePanel
            status={result.status}
            error={result.error}
            what="finance report"
            hint="The finance report needs the finance relation on the organization."
          />
        ) : (
          <FinanceTable report={result.data} currency={currency} codeOf={codeOf} />
        )}
      </CardBody>
    </Card>
  );
}

function FinanceTable({
  report,
  currency,
  codeOf,
}: {
  report: FinanceReport;
  currency: string | null;
  codeOf: (id: string) => string;
}) {
  const shown = currency ?? report.currency_totals[0]?.currency ?? null;
  if (shown === null)
    return <p className="text-muted text-sm">No payments or refunds in this window.</p>;
  const money = (v: number) => formatMoney(v, shown);
  const total = report.currency_totals.find((t) => t.currency === shown);
  const rows = report.rows.filter((r) => r.currency === shown);
  return (
    <div className="space-y-4">
      {total && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Kpi label={`Captured (${shown})`} value={money(total.captured_minor)} />
          <Kpi label="PSP fees — unreconciled" value={money(total.fee_minor)} />
          <Kpi label="Fee not known yet" value={`${total.fee_unknown} payments`} />
          <Kpi label="Refunded" value={money(total.refunded_minor)} />
        </div>
      )}
      <table className="w-full text-sm">
        <caption className="text-muted mb-2 text-left text-xs">
          Per store, {shown}. Fees are not reconciled with the PSP payouts yet.
        </caption>
        <thead className="text-muted text-xs uppercase">
          <tr className="border-line border-b">
            <th className="py-2 text-left font-medium">Store</th>
            <th className="py-2 text-right font-medium">Captured</th>
            <th className="py-2 text-right font-medium">Fees</th>
            <th className="py-2 text-right font-medium">Returns</th>
            <th className="py-2 text-right font-medium">Cancellations</th>
            <th className="py-2 text-right font-medium">Goodwill</th>
            <th className="py-2 text-right font-medium">Chargebacks</th>
          </tr>
        </thead>
        <tbody className="divide-line divide-y">
          {rows.map((r) => (
            <tr key={r.store_id}>
              <td className="py-2 font-mono text-xs">{codeOf(r.store_id)}</td>
              <td className="py-2 text-right font-mono tabular-nums">{money(r.captured_minor)}</td>
              <td className="py-2 text-right font-mono tabular-nums">{money(r.fee_minor)}</td>
              <td className="py-2 text-right font-mono tabular-nums">
                {money(r.refunded_by_reason.return)}
              </td>
              <td className="py-2 text-right font-mono tabular-nums">
                {money(r.refunded_by_reason.cancellation)}
              </td>
              <td className="py-2 text-right font-mono tabular-nums">
                {money(r.refunded_by_reason.goodwill)}
              </td>
              <td className="py-2 text-right font-mono tabular-nums">
                {money(r.refunded_by_reason.chargeback)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StockCard({
  result,
  stores,
  current,
  window,
  currency,
}: {
  result: Awaited<ReturnType<typeof getStoreStockReport>> | null;
  stores: StoreRef[];
  current: string | undefined;
  window: ReportWindow;
  currency: string | null;
}) {
  return (
    <Card>
      <CardHeader
        title="Stock"
        description="The pool rows a store sells from, now. On a shared item, reserved is held by every brand that maps it."
      />
      <CardBody className="space-y-4">
        {stores.length > 0 && (
          <nav aria-label="Store" className="border-line flex gap-1 border-b">
            {stores.map((s) => (
              <a
                key={s.store_id}
                href={biHref(window, { currency: currency ?? undefined, stock: s.store_id })}
                aria-current={s.store_id === current ? 'page' : undefined}
                className={
                  s.store_id === current
                    ? 'border-accent text-ink -mb-px border-b-2 px-3 py-2 font-mono text-sm'
                    : 'text-muted hover:text-ink px-3 py-2 font-mono text-sm'
                }
              >
                {s.code}
              </a>
            ))}
          </nav>
        )}
        {result === null ? (
          <p className="text-muted text-sm">No store to show.</p>
        ) : !result.ok ? (
          <ApiStatePanel status={result.status} error={result.error} what="stock report" />
        ) : (
          <StockTable report={result.data} />
        )}
      </CardBody>
    </Card>
  );
}

function StockTable({ report }: { report: StockReport }) {
  if (report.items.length === 0) return <p className="text-muted text-sm">No stock rows.</p>;
  return (
    <table className="w-full text-sm">
      <caption className="text-muted mb-2 text-left text-xs">
        First {report.items.length} of {report.total} pool rows, by SKU.
      </caption>
      <thead className="text-muted text-xs uppercase">
        <tr className="border-line border-b">
          <th className="py-2 text-left font-medium">SKU</th>
          <th className="py-2 text-left font-medium">Warehouse</th>
          <th className="py-2 text-right font-medium">On hand</th>
          <th className="py-2 text-right font-medium">Reserved</th>
          <th className="py-2 text-right font-medium">Incoming</th>
          <th className="py-2 text-right font-medium">Available</th>
        </tr>
      </thead>
      <tbody className="divide-line divide-y">
        {report.items.map((r) => (
          <tr key={`${r.stock_item_id}:${r.warehouse_id}`}>
            <td className="py-2 font-mono text-xs">{r.sku}</td>
            <td className="py-2 font-mono text-xs">{r.warehouse_code}</td>
            <td className="py-2 text-right font-mono tabular-nums">{r.on_hand}</td>
            <td className="py-2 text-right font-mono tabular-nums">{r.reserved}</td>
            <td className="py-2 text-right font-mono tabular-nums">{r.incoming}</td>
            <td className="py-2 text-right font-mono tabular-nums">{r.available}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
