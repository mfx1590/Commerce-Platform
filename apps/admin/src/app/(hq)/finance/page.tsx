import Link from 'next/link';
import { HqSectionGuard } from '@/components/shell/section-guard';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import {
  getErpSyncStatus,
  getTrialBalance,
  listJournalLines,
  listLegalEntityBooks,
  listParkedEvents,
  listPayouts,
} from '@/lib/api/accounting';
import { FINANCE_TABS, financeHref, readFinanceView } from '@/lib/finance';
import { AccountingStatePanel } from './accounting-state';
import {
  EntityList,
  JournalFilters,
  JournalPanel,
  PeriodForm,
  TrialBalancePanel,
} from './finance-panels';
import { ErpStatusPanel, ParkedEventsPanel, PayoutFilters, PayoutsPanel } from './payout-panels';

export const dynamic = 'force-dynamic';

const TAB_TITLES = {
  'trial-balance': 'Trial balance',
  journal: 'Journal',
  payouts: 'Payouts',
  ops: 'Parked events & ERP',
} as const;

/**
 * HQ › Finance (#851): the Accounting API's reads, `finance` on organization:hq. Legal entities with
 * books, then for the chosen one its trial balance (per currency, balanced or not), its journal
 * (filtered, paged), its payouts and their reconciliation, or the ops view (parked events, ERP
 * sync). Only the chosen tab's operations are called. Read-only: the ledger is derived from events, nothing here writes.
 */
export default async function FinancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const view = readFinanceView(await searchParams);
  const books = await listLegalEntityBooks();
  const entity = books.ok
    ? (books.data.items.find((each) => each.legal_entity_id === view.entity) ??
      (view.entity === null ? books.data.items[0] : undefined))
    : undefined;
  const scoped = entity === undefined ? null : { ...view, entity: entity.legal_entity_id };
  const id = scoped?.entity ?? null;
  const [trialBalance, journal, payouts, erp, parked] = await Promise.all([
    id !== null && view.tab === 'trial-balance'
      ? getTrialBalance(id, {
          ...view.period,
          ...(view.currency ? { currency: view.currency } : {}),
        })
      : null,
    id !== null && view.tab === 'journal' ? listJournalLines(id, view.journal) : null,
    id !== null && view.tab === 'payouts' ? listPayouts(id, view.payouts) : null,
    id !== null && view.tab === 'ops' ? getErpSyncStatus(id) : null,
    id !== null && view.tab === 'ops' ? listParkedEvents(id, view.parked) : null,
  ]);

  return (
    <HqSectionGuard id="finance">
      <Card>
        <CardHeader
          title="Finance"
          description="The ledger per legal entity, read from the accounting service: books, trial balance, journal, payouts and the ops view. Amounts stay in their own currency."
        />
        <CardBody className="space-y-5">
          {!books.ok ? (
            <AccountingStatePanel status={books.status} error={books.error} what="The books" />
          ) : (
            <>
              <EntityList
                entities={books.data.items}
                selected={entity?.legal_entity_id ?? null}
                tab={view.tab}
              />
              {view.entity !== null && entity === undefined && (
                <p role="alert" className="text-danger text-sm">
                  That legal entity has no books here. Pick one above.
                </p>
              )}
              {view.ignored.length > 0 && (
                <p role="status" className="text-muted text-sm">
                  Ignored (not valid): {view.ignored.join(', ')}.
                </p>
              )}
              {scoped !== null && entity !== undefined && (
                <section aria-label={`${entity.name} books`} className="space-y-4">
                  <nav aria-label="Finance views" className="flex gap-2 text-sm">
                    {FINANCE_TABS.map((tab) => (
                      <Link
                        key={tab}
                        href={financeHref(
                          { entity: scoped.entity, tab },
                          { ...view.period, currency: view.currency },
                        )}
                        aria-current={tab === view.tab ? 'page' : undefined}
                        className={
                          tab === view.tab
                            ? 'bg-accent/10 text-accent rounded px-2 py-1 font-medium'
                            : 'text-muted rounded px-2 py-1 hover:underline'
                        }
                      >
                        {TAB_TITLES[tab]}
                      </Link>
                    ))}
                  </nav>
                  {view.tab !== 'ops' && (
                    <PeriodForm
                      view={scoped}
                      currencies={entity.currencies}
                      withCurrency={view.tab !== 'payouts'}
                    >
                      {view.tab === 'journal' && <JournalFilters view={scoped} />}
                      {view.tab === 'payouts' && <PayoutFilters view={scoped} />}
                    </PeriodForm>
                  )}
                  {trialBalance !== null &&
                    (trialBalance.ok ? (
                      <TrialBalancePanel trialBalance={trialBalance.data} />
                    ) : (
                      <AccountingStatePanel
                        status={trialBalance.status}
                        error={trialBalance.error}
                        what="The trial balance"
                      />
                    ))}
                  {journal !== null &&
                    (journal.ok ? (
                      <JournalPanel page={journal.data} view={scoped} />
                    ) : (
                      <AccountingStatePanel
                        status={journal.status}
                        error={journal.error}
                        what="The journal"
                      />
                    ))}
                  {payouts !== null &&
                    (payouts.ok ? (
                      <PayoutsPanel page={payouts.data} view={scoped} />
                    ) : (
                      <AccountingStatePanel
                        status={payouts.status}
                        error={payouts.error}
                        what="The payouts"
                      />
                    ))}
                  {erp !== null &&
                    (erp.ok ? (
                      <ErpStatusPanel status={erp.data} />
                    ) : (
                      <AccountingStatePanel
                        status={erp.status}
                        error={erp.error}
                        what="The ERP sync status"
                      />
                    ))}
                  {parked !== null &&
                    (parked.ok ? (
                      <ParkedEventsPanel page={parked.data} view={scoped} />
                    ) : (
                      <AccountingStatePanel
                        status={parked.status}
                        error={parked.error}
                        what="The parked events"
                      />
                    ))}
                </section>
              )}
            </>
          )}
        </CardBody>
      </Card>
    </HqSectionGuard>
  );
}
