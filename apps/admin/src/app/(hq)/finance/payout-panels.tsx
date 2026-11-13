import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import type {
  ErpSyncStatus,
  ParkedEventPage,
  PayoutDetail,
  PayoutPage,
} from '@/lib/api/accounting-client';
import { formatMoney } from '@/lib/forms/money';
import { MATCH_LABELS, PAYOUT_STATUSES, financeHref, type FinanceView } from '@/lib/finance';

const th = 'py-1 pr-4 font-medium';
const td = 'py-1 pr-4';
const num = 'py-1 pr-4 text-right font-mono tabular-nums';

const STATUS_TONE = { reconciled: 'success', discrepant: 'danger', imported: 'neutral' } as const;

function Pager({
  label,
  page,
  limit,
  total,
  href,
}: {
  label: string;
  page: number;
  limit: number;
  total: number;
  href: (page: number) => string;
}) {
  const pages = Math.max(1, Math.ceil(total / limit));
  return (
    <nav aria-label={label} className="flex items-center gap-3 text-sm">
      <span className="text-muted">
        Page {page} of {pages} · {total}
      </span>
      {page > 1 && (
        <Link href={href(page - 1)} className="text-accent hover:underline">
          Previous
        </Link>
      )}
      {page < pages && (
        <Link href={href(page + 1)} className="text-accent hover:underline">
          Next
        </Link>
      )}
    </nav>
  );
}

/** The payout filters beyond the period (`listPayouts` declares status and provider; no currency). */
export function PayoutFilters({ view }: { view: FinanceView }) {
  return (
    <>
      <label className="flex flex-col">
        <span className="text-muted text-xs">Status</span>
        <select
          name="status"
          defaultValue={view.payouts.status ?? ''}
          className="border-line rounded border px-2 py-1"
        >
          <option value="">Any</option>
          {PAYOUT_STATUSES.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col">
        <span className="text-muted text-xs">Provider</span>
        <input
          name="provider"
          defaultValue={view.payouts.provider ?? ''}
          className="border-line w-28 rounded border px-2 py-1"
        />
      </label>
    </>
  );
}

/**
 * `listPayouts`: what reached the bank per PSP payout, each in its own currency, and how far
 * reconciliation got (matched lines of all lines, lines that are not matched).
 */
export function PayoutsPanel({ page, view }: { page: PayoutPage; view: FinanceView }) {
  if (page.items.length === 0) {
    return (
      <p role="status" className="text-muted text-sm">
        No payouts match these filters.
      </p>
    );
  }
  const entity = view.entity ?? '';
  return (
    <div className="space-y-2">
      <table className="text-sm" aria-label="Payouts">
        <thead className="text-muted text-left text-xs">
          <tr>
            <th className={th}>Arrival</th>
            <th className={th}>Provider</th>
            <th className={th}>Payout</th>
            <th className={`${th} text-right`}>Amount</th>
            <th className={th}>Status</th>
            <th className={`${th} text-right`}>Matched</th>
            <th className={`${th} text-right`}>Not matched</th>
            <th className={th}>Posted</th>
          </tr>
        </thead>
        <tbody>
          {page.items.map((payout) => (
            <tr key={payout.id}>
              <td className={td}>{payout.arrival_date}</td>
              <td className={td}>{payout.provider}</td>
              <td className={td}>
                <Link
                  href={`/finance/payouts/${payout.id}?entity=${entity}`}
                  className="text-accent font-mono text-xs hover:underline"
                >
                  {payout.provider_payout_id}
                </Link>
              </td>
              <td className={num}>{formatMoney(payout.amount_minor, payout.currency)}</td>
              <td className={td}>
                <Badge tone={STATUS_TONE[payout.status]}>{payout.status}</Badge>
              </td>
              <td className={num}>
                {payout.matched_count} / {payout.line_count}
              </td>
              <td className={num}>{payout.discrepancy_count}</td>
              <td className={td}>
                {payout.posted_at === null ? 'not yet' : payout.posted_at.slice(0, 10)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pager
        label="Payout pages"
        page={page.page}
        limit={page.limit}
        total={page.total}
        href={(to) =>
          financeHref(view, {
            ...(view.payouts as Record<string, string | number | undefined>),
            page: to,
          })
        }
      />
    </div>
  );
}

/**
 * `getPayout`: one payout and its balance-transaction lines with their verdicts. A line's
 * `difference_minor` is PSP amount − ledger amount; a fee mismatch is shown with the fee next to it.
 */
export function PayoutDetailPanel({ payout, entity }: { payout: PayoutDetail; entity: string }) {
  const lines = payout.lines;
  return (
    <div className="space-y-4">
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[12rem_1fr]" aria-label="Payout">
        <dt className="text-muted">Provider</dt>
        <dd>
          {payout.provider} <span className="font-mono text-xs">{payout.provider_payout_id}</span>
        </dd>
        <dt className="text-muted">Amount</dt>
        <dd className="font-mono">{formatMoney(payout.amount_minor, payout.currency)}</dd>
        <dt className="text-muted">Arrival</dt>
        <dd>{payout.arrival_date}</dd>
        <dt className="text-muted">Status</dt>
        <dd>
          <Badge tone={STATUS_TONE[payout.status]}>{payout.status}</Badge>{' '}
          <span className="text-muted">
            {payout.matched_count} of {payout.line_count} lines matched
            {payout.discrepancy_count > 0 ? `, ${payout.discrepancy_count} not` : ''}
          </span>
        </dd>
        <dt className="text-muted">Posted to the ERP</dt>
        <dd>{payout.posted_at ?? 'not yet'}</dd>
      </dl>
      {lines.items.length === 0 ? (
        <p role="status" className="text-muted text-sm">
          This payout has no lines on this page.
        </p>
      ) : (
        <table className="text-sm" aria-label="Payout lines">
          <thead className="text-muted text-left text-xs">
            <tr>
              <th className={th}>Kind</th>
              <th className={th}>Transaction</th>
              <th className={`${th} text-right`}>Amount</th>
              <th className={`${th} text-right`}>Fee</th>
              <th className={`${th} text-right`}>Net</th>
              <th className={th}>Verdict</th>
              <th className={`${th} text-right`}>Difference</th>
              <th className={th}>Matched to</th>
            </tr>
          </thead>
          <tbody>
            {lines.items.map((line) => (
              <tr key={line.id}>
                <td className={td}>{line.kind}</td>
                <td className={`${td} font-mono text-xs`}>
                  {line.provider_txn_id}
                  {line.provider_reference !== null && (
                    <span className="text-muted block">{line.provider_reference}</span>
                  )}
                </td>
                <td className={num}>{formatMoney(line.amount_minor, line.currency)}</td>
                <td className={num}>{formatMoney(line.fee_minor, line.currency)}</td>
                <td className={num}>{formatMoney(line.net_minor, line.currency)}</td>
                <td className={td}>
                  <Badge
                    tone={
                      line.match_status === 'matched'
                        ? 'success'
                        : line.match_status === 'pending'
                          ? 'neutral'
                          : 'danger'
                    }
                  >
                    {MATCH_LABELS[line.match_status] ?? line.match_status}
                  </Badge>
                </td>
                <td className={num}>
                  {line.difference_minor === 0
                    ? ''
                    : formatMoney(line.difference_minor, line.currency)}
                </td>
                <td className={td}>
                  {line.matched_reference_type === null ? (
                    '—'
                  ) : (
                    <span>
                      {line.matched_reference_type}{' '}
                      <span className="font-mono text-xs">
                        {String(line.matched_reference_id ?? '').slice(0, 8)}
                      </span>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Pager
        label="Payout line pages"
        page={lines.page}
        limit={lines.limit}
        total={lines.total}
        href={(to) => `/finance/payouts/${payout.id}?entity=${entity}&page=${to}`}
      />
    </div>
  );
}

/** `getErpSyncStatus`: the Odoo mapping and how far posting got. */
export function ErpStatusPanel({ status }: { status: ErpSyncStatus }) {
  const unmapped = status.chart.unmapped_codes;
  return (
    <section aria-label="ERP sync" className="space-y-2">
      <h3 className="font-semibold">ERP sync</h3>
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[14rem_1fr]">
        <dt className="text-muted">Odoo company</dt>
        <dd>{status.odoo_company_id ?? 'not mapped — nothing can be posted'}</dd>
        <dt className="text-muted">Chart of accounts</dt>
        <dd>
          {status.chart.mapped} of {status.chart.accounts} accounts mapped
          {unmapped.length > 0 && (
            <span role="alert" className="text-danger block">
              Not mapped: <span className="font-mono">{unmapped.join(', ')}</span>
            </span>
          )}
        </dd>
        <dt className="text-muted">Entries</dt>
        <dd>
          {status.posted_entries} of {status.entries} posted, {status.unposted_entries} waiting
        </dd>
        <dt className="text-muted">Oldest waiting entry</dt>
        <dd>{status.oldest_unposted_entry_date ?? '—'}</dd>
        <dt className="text-muted">Last posted</dt>
        <dd>{status.last_posted_at ?? 'never'}</dd>
      </dl>
    </section>
  );
}

/**
 * `listParkedEvents`: events that arrived before their `order.placed`. A list that does not drain
 * means an `order.placed` is missing from the bus — the reason it is shown at all.
 */
export function ParkedEventsPanel({ page, view }: { page: ParkedEventPage; view: FinanceView }) {
  return (
    <section aria-label="Parked events" className="space-y-2">
      <h3 className="font-semibold">Parked events</h3>
      {page.items.length === 0 ? (
        <p role="status" className="text-muted text-sm">
          Nothing is parked: every event found its order.
        </p>
      ) : (
        <>
          <p className="text-muted text-sm">
            These arrived before their order was placed. If they stay here, that order&apos;s
            <span className="font-mono"> order.placed</span> is missing from the bus.
          </p>
          <table className="text-sm" aria-label="Parked event list">
            <thead className="text-muted text-left text-xs">
              <tr>
                <th className={th}>Topic</th>
                <th className={th}>Order</th>
                <th className={th}>Occurred</th>
                <th className={th}>Parked</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((event) => (
                <tr key={event.outbox_id}>
                  <td className={`${td} font-mono text-xs`}>
                    {event.topic} v{event.version}
                  </td>
                  <td className={td}>
                    <Link
                      href={`/${event.store_id}/orders/${event.order_id}`}
                      className="text-accent font-mono text-xs hover:underline"
                    >
                      {event.order_id.slice(0, 8)}
                    </Link>
                  </td>
                  <td className={td}>{event.occurred_at}</td>
                  <td className={td}>{event.parked_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager
            label="Parked event pages"
            page={page.page}
            limit={page.limit}
            total={page.total}
            href={(to) => financeHref(view, { page: to })}
          />
        </>
      )}
    </section>
  );
}
