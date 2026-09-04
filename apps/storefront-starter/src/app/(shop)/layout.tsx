import type { ReactNode } from 'react';
import { getLayouts } from '@/lib/slots';
import { getStoreOrNull } from '@/lib/store';

/** Shop chrome: header and footer come from the layout slots, so a brand can replace either. */
export default async function ShopLayout({ children }: { children: ReactNode }) {
  const store = await getStoreOrNull();
  const { Header, Footer } = getLayouts();

  return (
    <div className="flex min-h-screen flex-col">
      <Header store={store} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10">{children}</main>
      <Footer store={store} />
    </div>
  );
}
