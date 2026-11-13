import Link from 'next/link';
import { HqSectionGuard } from '@/components/shell/section-guard';
import { ApiStatePanel } from '@/components/states/state-panel';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { getPayout } from '@/lib/api/accounting';
import { financeHref } from '@/lib/finance';
import { PayoutDetailPanel } from '../../payout-panels';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * One payout (#851, `getPayout`): its balance-transaction lines and their verdicts, paged.
 * `?entity=` is the legal entity the payout belongs to (every Accounting API read is scoped by it).
 */
export default async function PayoutPage({
  params,
  searchParams,
}: {
  params: Promise<{ payoutId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { payoutId } = await params;
  const search = await searchParams;
  const entity = one(search['entity']) ?? '';
  const pageText = one(search['page']);
  const page =
    pageText !== undefined && /^[1-9]\d{0,5}$/.test(pageText) ? Number(pageText) : undefined;
  const valid = UUID.test(payoutId) && UUID.test(entity);
  const payout = valid ? await getPayout(entity, payoutId, page ? { page } : {}) : null;
  const back = UUID.test(entity) ? financeHref({ entity, tab: 'payouts' }, {}) : '/finance';

  return (
    <HqSectionGuard id="finance">
      <Card>
        <CardHeader
          title="Payout"
          description="What the payment provider paid out, line by line, and whether each line matches the ledger."
          action={
            <Link href={back} className="text-accent text-sm hover:underline">
              All payouts
            </Link>
          }
        />
        <CardBody>
          {payout === null ? (
            <p role="alert" className="text-danger text-sm">
              That is not a payout of a legal entity. Open it from the payouts list.
            </p>
          ) : payout.ok ? (
            <PayoutDetailPanel payout={payout.data} entity={entity} />
          ) : (
            <ApiStatePanel
              status={payout.status}
              error={payout.error}
              what="This payout"
              backHref={back}
              backLabel="All payouts"
            />
          )}
        </CardBody>
      </Card>
    </HqSectionGuard>
  );
}
