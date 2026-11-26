import Link from 'next/link';
import { StoreSectionGuard } from '@/components/shell/section-guard';
import { RequestErrorPanel } from '@/components/states/state-panel';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { getProduct, listCategories, listMerchandisingRules } from '@/lib/api/admin';
import { CATALOG_PERMISSIONS } from '@/lib/catalog/permissions';
import { RULE_FILTER_KEYS } from '@/lib/catalog/merchandising';
import { holds } from '@/lib/permissions/rules';
import { loadPrincipal } from '@/lib/principal';
import { RulesScreen, type ProductRef } from './rules-screen';

export const dynamic = 'force-dynamic';

/** Names are read one product at a time (the API lists products by search, not by id). */
const NAMES_CAP = 300;
const NAMES_CONCURRENCY = 6;

async function productRefs(
  storeId: string,
  ids: readonly string[],
): Promise<{ refs: Record<string, ProductRef>; unread: number }> {
  const wanted = ids.slice(0, NAMES_CAP);
  const refs: Record<string, ProductRef> = {};
  let next = 0;
  const lane = async () => {
    while (next < wanted.length) {
      const id = wanted[next]!;
      next += 1;
      const result = await getProduct(storeId, id);
      if (result.ok) refs[id] = { title: result.data.title, status: result.data.status };
      else if (result.status === 404) refs[id] = { title: null, status: 'missing' };
    }
  };
  await Promise.all(Array.from({ length: Math.min(NAMES_CONCURRENCY, wanted.length) }, lane));
  return { refs, unread: ids.length - wanted.length };
}

export default async function MerchandisingPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { storeId } = await params;
  const raw = await searchParams;
  const filters: Record<string, string> = {};
  for (const key of RULE_FILTER_KEYS) {
    const value = raw[key];
    if (typeof value === 'string' && value !== '') filters[key] = value;
  }

  const [rules, categories, principal] = await Promise.all([
    listMerchandisingRules(storeId),
    listCategories(storeId),
    loadPrincipal(),
  ]);
  const canAdmin =
    principal.ok && holds(principal.data, CATALOG_PERMISSIONS.updateMerchandisingRule, storeId);
  const ids = rules.ok
    ? [
        ...new Set(
          rules.data.items.flatMap((rule) => [
            ...rule.pins,
            ...rule.boosts.map((b) => b.product_id),
            ...rule.buries,
          ]),
        ),
      ]
    : [];
  const { refs, unread } = await productRefs(storeId, ids);

  return (
    <StoreSectionGuard storeId={storeId} id="catalog">
      <Card>
        <CardHeader
          title="Search merchandising"
          description="Pin, boost and bury products in search, per category or per search query. Changes reach shoppers only when published. Reading needs store_staff; changing and publishing need store_admin."
          action={
            <Link href={`/${storeId}/catalog`} className="text-accent text-sm hover:underline">
              Back to products
            </Link>
          }
        />
        <CardBody>
          {rules.ok ? (
            <RulesScreen
              storeId={storeId}
              rules={rules.data.items}
              categories={
                categories.ok ? categories.data.items.map((c) => ({ id: c.id, name: c.name })) : []
              }
              categoriesError={categories.ok ? null : categories.error.message}
              products={refs}
              unreadNames={unread}
              filters={filters}
              canAdmin={canAdmin}
              now={new Date().toISOString()}
            />
          ) : (
            <RequestErrorPanel status={rules.status} error={rules.error} />
          )}
        </CardBody>
      </Card>
    </StoreSectionGuard>
  );
}
