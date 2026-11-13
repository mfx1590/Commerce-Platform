import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import type { JournalLinePage, LegalEntityBooks, TrialBalance } from '@/lib/api/accounting-client';
import { formatMoney } from '@/lib/forms/money';
import {
  ERP_STATES,
  JOURNALS,
  REFERENCE_TYPES,
  balanceByCurrency,
  currenciesWithoutTotals,
  financeHref,
  referenceHref,
  type FinanceView,
} from '@/lib/finance';

const th = 'py-1 pr-4 font-medium';
const td = 'py-1 pr-4';
const num = 'py-1 pr-4 text-right font-mono tabular-nums';

/** The legal entities with books (`listLegalEntityBooks`): pick one; every read below is scoped by it. */
export function EntityList({
  entities,
  selected,
  tab,
}: {
  entities: readonly LegalEntityBooks[];
  selected: string | null;
  tab: FinanceView['tab'];
}) {
  if (entities.length === 0) {
    return (
      <p role="status" className="text-muted text-sm">
        No legal entity has books yet: nothing has been posted to the ledger.
      </p>
    );
  }
  return (
    <table className="text-sm" aria-label="Legal entities">
      <thead className="text-muted text-left text-xs">
        <tr>
          <th className={th}>Legal entity</th>
          <th className={th}>Currencies</th>
          <th className={`${th} text-right`}>Entries</th>
          <th className={`${th} text-right`}>Not in the ERP</th>
          <th className={th}>Period</th>
          <th className={th}>ERP company</th>
        </tr>
      </thead>
      <tbody>
        {entities.map((entity) => (
          <tr
            key={entity.legal_entity_id}
            aria-current={entity.legal_entity_id === selected ? 'true' : undefined}
            className={entity.legal_entity_id === selected ? 'bg-accent/5' : undefined}
          >
            <td className={td}>
              <Link
                href={financeHref({ entity: entity.legal_entity_id, tab }, {})}
                className="text-accent hover:underline"
              >
                {entity.name}
              </Link>{' '}
              <span className="text-muted font-mono text-xs">{entity.code}</span>
            </td>
            <td className={`${td} font-mono`}>{entity.currencies.join(', ')}</td>
            <td className={num}>{entity.entries}</td>
            <td className={num}>{entity.unposted_entries}</td>
            <td className={td}>
              {entity.first_entry_date === null
                ? '—'
                : `${entity.first_entry_date} – ${entity.last_entry_date ?? '…'}`}
            </td>
            <td className={td}>{entity.odoo_company_id ?? 'not mapped'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Period and currency, as a GET form: the URL is the state, the server reads it. */
export function PeriodForm({
  view,
  currencies,
  children,
}: {
  view: FinanceView;
  currencies: readonly string[];
  children?: React.ReactNode;
}) {
  return (
    <form
      method="get"
      action="/finance"
      aria-label="Period"
      className="flex flex-wrap items-end gap-3 text-sm"
    >
      {view.entity !== null && <input type="hidden" name="entity" value={view.entity} />}
      <input type="hidden" name="tab" value={view.tab} />
      <label className="flex flex-col">
        <span className="text-muted text-xs">From</span>
        <input
          type="date"
          name="from"
          defaultValue={view.period.from ?? ''}
          className="border-line rounded border px-2 py-1"
        />
      </label>
      <label className="flex flex-col">
        <span className="text-muted text-xs">To</span>
        <input
          type="date"
          name="to"
          defaultValue={view.period.to ?? ''}
          className="border-line rounded border px-2 py-1"
        />
      </label>
      <label className="flex flex-col">
        <span className="text-muted text-xs">Currency</span>
        <select
          name="currency"
          defaultValue={view.currency ?? ''}
          className="border-line rounded border px-2 py-1"
        >
          <option value="">Each currency</option>
          {currencies.map((currency) => (
            <option key={currency} value={currency}>
              {currency}
            </option>
          ))}
        </select>
      </label>
      {children}
      <button type="submit" className="border-line rounded border px-3 py-1">
        Show
      </button>
    </form>
  );
}

/**
 * `getTrialBalance`: rows per (currency, account) and the service's totals per currency, each
 * stated balanced or not. Currencies are separate tables; nothing is added across them.
 */
export function TrialBalancePanel({ trialBalance }: { trialBalance: TrialBalance }) {
  const balances = balanceByCurrency(trialBalance);
  const orphans = currenciesWithoutTotals(trialBalance);
  const period = `${trialBalance.from ?? 'the first entry'} – ${trialBalance.to ?? 'the last entry'}`;
  if (balances.length === 0 && orphans.length === 0) {
    return (
      <p role="status" className="text-muted text-sm">
        No ledger lines in {period}: there is nothing to balance. That is not a balanced book —
        check the period and the currency.
      </p>
    );
  }
  return (
    <div className="space-y-5">
      {balances.map((balance) => (
        <section
          key={balance.currency}
          aria-label={`Trial balance ${balance.currency}`}
          className="space-y-2"
        >
          <div className="flex items-center gap-3">
            <h3 className="font-semibold">{balance.currency}</h3>
            <Badge tone={balance.balanced ? 'success' : 'danger'}>
              {balance.balanced
                ? 'Balanced'
                : balance.difference_minor !== 0
                  ? `Unbalanced by ${formatMoney(Math.abs(balance.difference_minor), balance.currency)}`
                  : 'Unbalanced: debits and credits differ'}
            </Badge>
            <span className="text-muted text-xs">{period}</span>
          </div>
          <table className="text-sm" aria-label={`Accounts ${balance.currency}`}>
            <AccountRows trialBalance={trialBalance} currency={balance.currency} />
            <tfoot className="font-medium">
              <tr>
                <td className={td} colSpan={2}>
                  Total {balance.currency}
                </td>
                <td className={num}>{formatMoney(balance.debit_minor, balance.currency)}</td>
                <td className={num}>{formatMoney(balance.credit_minor, balance.currency)}</td>
                <td className={num}>{formatMoney(balance.difference_minor, balance.currency)}</td>
              </tr>
            </tfoot>
          </table>
        </section>
      ))}
      {orphans.map((currency) => (
        <section key={currency} aria-label={`Trial balance ${currency}`} className="space-y-2">
          <div className="flex items-center gap-3">
            <h3 className="font-semibold">{currency}</h3>
            <Badge tone="danger">No total from the service — not checked</Badge>
            <span className="text-muted text-xs">{period}</span>
          </div>
          <table className="text-sm" aria-label={`Accounts ${currency}`}>
            <AccountRows trialBalance={trialBalance} currency={currency} />
          </table>
        </section>
      ))}
    </div>
  );
}

/** Header and rows of one currency's accounts (never mixed with another currency). */
function AccountRows({ trialBalance, currency }: { trialBalance: TrialBalance; currency: string }) {
  return (
    <>
      <thead className="text-muted text-left text-xs">
        <tr>
          <th className={th}>Account</th>
          <th className={th}>Type</th>
          <th className={`${th} text-right`}>Debit</th>
          <th className={`${th} text-right`}>Credit</th>
          <th className={`${th} text-right`}>Balance</th>
        </tr>
      </thead>
      <tbody>
        {trialBalance.rows
          .filter((row) => row.currency === currency)
          .map((row) => (
            <tr key={row.account_code}>
              <td className={td}>
                <span className="font-mono">{row.account_code}</span> {row.account_name}
              </td>
              <td className={td}>{row.account_type}</td>
              <td className={num}>{formatMoney(row.debit_minor, row.currency)}</td>
              <td className={num}>{formatMoney(row.credit_minor, row.currency)}</td>
              <td className={num}>{formatMoney(row.balance_minor, row.currency)}</td>
            </tr>
          ))}
      </tbody>
    </>
  );
}

/** The journal filters beyond the period (each one a declared `listJournalLines` parameter). */
export function JournalFilters({ view }: { view: FinanceView }) {
  const select = (name: string, label: string, options: readonly string[], value?: string) => (
    <label className="flex flex-col">
      <span className="text-muted text-xs">{label}</span>
      <select
        name={name}
        defaultValue={value ?? ''}
        className="border-line rounded border px-2 py-1"
      >
        <option value="">Any</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <>
      {select('journal', 'Journal', JOURNALS, view.journal.journal)}
      <label className="flex flex-col">
        <span className="text-muted text-xs">Account</span>
        <input
          name="account_code"
          defaultValue={view.journal.account_code ?? ''}
          className="border-line w-24 rounded border px-2 py-1"
        />
      </label>
      {select('reference_type', 'Reference', REFERENCE_TYPES, view.journal.reference_type)}
      <label className="flex flex-col">
        <span className="text-muted text-xs">Reference id</span>
        <input
          name="reference_id"
          defaultValue={view.journal.reference_id ?? ''}
          className="border-line w-72 rounded border px-2 py-1 font-mono text-xs"
        />
      </label>
      {select('erp', 'ERP', ERP_STATES, view.journal.erp)}
    </>
  );
}

/** `listJournalLines`: one page, each amount in its own currency, an order reference opens the order. */
export function JournalPanel({ page, view }: { page: JournalLinePage; view: FinanceView }) {
  if (page.items.length === 0) {
    return (
      <p role="status" className="text-muted text-sm">
        No journal lines match these filters.
      </p>
    );
  }
  const pages = Math.max(1, Math.ceil(page.total / page.limit));
  const current = { ...view.journal };
  const href = (to: number) =>
    financeHref(view, { ...(current as Record<string, string | number | undefined>), page: to });
  return (
    <div className="space-y-2">
      <table className="text-sm" aria-label="Journal lines">
        <thead className="text-muted text-left text-xs">
          <tr>
            <th className={th}>Date</th>
            <th className={th}>Journal</th>
            <th className={th}>Account</th>
            <th className={`${th} text-right`}>Debit</th>
            <th className={`${th} text-right`}>Credit</th>
            <th className={th}>Source</th>
            <th className={th}>Reference</th>
            <th className={th}>ERP</th>
          </tr>
        </thead>
        <tbody>
          {page.items.map((line) => {
            const link = referenceHref(line);
            return (
              <tr key={line.id}>
                <td className={td}>{line.entry_date}</td>
                <td className={td}>{line.journal}</td>
                <td className={td}>
                  <span className="font-mono">{line.account_code}</span> {line.account_name}
                </td>
                <td className={num}>
                  {line.debit_minor === 0 ? '' : formatMoney(line.debit_minor, line.currency)}
                </td>
                <td className={num}>
                  {line.credit_minor === 0 ? '' : formatMoney(line.credit_minor, line.currency)}
                </td>
                <td className={`${td} font-mono text-xs`}>{line.source_topic}</td>
                <td className={td}>
                  {line.reference_type === null || line.reference_type === undefined ? (
                    '—'
                  ) : link !== null ? (
                    <Link href={link} className="text-accent hover:underline">
                      {line.reference_type} {String(line.reference_id).slice(0, 8)}
                    </Link>
                  ) : (
                    <span>
                      {line.reference_type}{' '}
                      <span className="font-mono text-xs">
                        {String(line.reference_id ?? '').slice(0, 8)}
                      </span>
                    </span>
                  )}
                </td>
                <td className={td}>
                  {line.posted_to_erp_at === null ? 'not yet' : (line.erp_reference ?? 'posted')}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <nav aria-label="Journal pages" className="flex items-center gap-3 text-sm">
        <span className="text-muted">
          Page {page.page} of {pages} · {page.total} lines
        </span>
        {page.page > 1 && (
          <Link href={href(page.page - 1)} className="text-accent hover:underline">
            Previous
          </Link>
        )}
        {page.page < pages && (
          <Link href={href(page.page + 1)} className="text-accent hover:underline">
            Next
          </Link>
        )}
      </nav>
    </div>
  );
}
