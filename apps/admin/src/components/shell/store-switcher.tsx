'use client';

import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { selectStore } from '@/app/actions/select-store';
import type { PrincipalStore } from '@/lib/nav/navigation';

/**
 * Lists exactly the principal's own `stores[]` — nothing inferred, HQ roles included. A plain form
 * plus a server action, so switching works without client JS; the chosen id is re-validated
 * server-side before it is remembered, and again by the store layout on the next request.
 *
 * The current section travels with the switch (Orders on brand-a → Orders on brand-b) so people do
 * not lose their place. It is derived here rather than passed down because a layout cannot read the
 * pathname.
 */
export function StoreSwitcher({
  stores,
  selectedStoreId,
}: {
  stores: readonly PrincipalStore[];
  selectedStoreId: string | null;
}) {
  const pathname = usePathname();

  if (stores.length === 0) return null;

  const [first, second] = pathname.split('/').filter((segment) => segment !== '');
  const onAStorePage =
    first !== undefined && stores.some((store) => store.store_id === decodeURIComponent(first));
  const section = onAStorePage && second !== undefined ? second : 'catalog';

  return (
    <form action={selectStore} className="flex items-center gap-2">
      <input type="hidden" name="section" value={section} />
      <label htmlFor="store-switcher" className="sr-only">
        Store
      </label>
      <select
        id="store-switcher"
        name="storeId"
        defaultValue={selectedStoreId ?? stores[0]?.store_id}
        className="border-line bg-surface h-9 rounded-md border px-2 text-sm"
      >
        {stores.map((store) => (
          <option key={store.store_id} value={store.store_id}>
            {store.name} ({store.code})
          </option>
        ))}
      </select>
      <Button type="submit" variant="secondary" size="sm">
        Switch
      </Button>
    </form>
  );
}
