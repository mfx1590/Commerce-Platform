import type { ReactNode } from 'react';
import { Shell } from '@/components/shell/shell';

export const dynamic = 'force-dynamic';

/**
 * Store view. The store id comes from the URL and is validated against the principal's `stores[]`
 * on every request, not once at switch time — so losing access to a store takes effect on the next
 * page load. A store outside that list renders the 403 panel with the switcher still available.
 */
export default async function StoreLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ storeId: string }>;
}) {
  const { storeId } = await params;
  return <Shell storeId={storeId}>{children}</Shell>;
}
