import Link from 'next/link';
import { HqSectionGuard } from '@/components/shell/section-guard';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { getTrialBalance, listJournalLines, listLegalEntityBooks } from '@/lib/api/accounting';
import { FINANCE_TABS, financeHref, readFinanceView } from '@/lib/finance';
import { AccountingStatePanel } from './accounting-state';
import {
  EntityList,
  JournalFilters,
  JournalPanel,
  PeriodForm,
  TrialBalancePanel,
} from './finance-panels';

export const dynamic = 'force-dynamic';

const TAB_TITLES = { 'trial-balance': 'Trial balance', journal: 'Journal' } as const;

/**
 * HQ › Finance (#851): the Accounting API's reads, `finance` on organization:hq. Legal entities with
 * books, then for the chosen one its trial balance (per currency, balanced or not) or its journal
 * (filtered, paged). Read-only: the ledger is derived from events, nothing here writes.
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
  const [trialBalance, journal] =
    scoped === null
      ? [null, null]
      : view.tab === 'trial-balance'
        ? [
            await getTrialBalance(scoped.entity, {
              ...view.period,
              ...(view.currency ? { currency: view.currency } : {}),
            }),
            null,
          ]
        : [null, await listJournalLines(scoped.entity, view.journal)];

  return (
    <HqSectionGuard id="finance">
      <Card>
        <CardHeader
          title="Finance"
          description="The ledger per legal entity, read from the accounting service: books, trial balance and journal. Amounts stay in their own currency."
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
                  <PeriodForm view={scoped} currencies={entity.currencies}>
                    {view.tab === 'journal' && <JournalFilters view={scoped} />}
                  </PeriodForm>
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
                </section>
              )}
            </>
          )}
        </CardBody>
      </Card>
    </HqSectionGuard>
  );
}
