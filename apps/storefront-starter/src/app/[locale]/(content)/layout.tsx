import type { ReactNode } from 'react';
import { getLayouts } from '@/lib/slots';
import { getStoreOrNull } from '@/lib/store';

/**
 * Content routes. Owned by window 6 (CMS) per docs/ownership.md — this layout and the placeholder
 * page below exist only so the route group and its chrome are in place; the Sanity client and the
 * real pages arrive with that window.
 */
export default async function ContentLayout({ children }: { children: ReactNode }) {
  const store = await getStoreOrNull();
  const { Header, Footer } = getLayouts();

  return (
    <div className="flex min-h-screen flex-col">
      <Header store={store} />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10">{children}</main>
      <Footer store={store} />
    </div>
  );
}
