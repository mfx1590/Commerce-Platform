import { redirect } from 'next/navigation';
import { storeNavItems } from '@/lib/nav/navigation';
import { loadPrincipal } from '@/lib/principal';

export const dynamic = 'force-dynamic';

/**
 * `/{storeId}` with no section: go to the first section this principal may open in that store.
 * When there is none — a store outside `stores[]` — render nothing and let the layout show the
 * 403 panel, which is also where the store switcher still lives.
 */
export default async function StoreIndexPage({ params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;
  const result = await loadPrincipal();

  if (result.ok) {
    const first = storeNavItems(result.data, storeId)[0];
    if (first !== undefined) {
      redirect(first.href);
    }
  }
  return null;
}
