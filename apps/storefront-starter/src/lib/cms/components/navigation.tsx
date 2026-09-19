import type { Link as CmsLink, NavigationDocument } from '@platform/cms';
import { Link } from '@/i18n/navigation';
import { getComponents } from '@/lib/slots';
import type { Store } from '@/lib/store-api';
import type { ContentContext } from '../content';
import { SafeLink } from './safe-link';

/**
 * The header for CMS-driven pages: the same shape as the starter's default header (logo slot,
 * main navigation, account and cart), with the navigation coming from the CMS `navigation`
 * document for the locale. When there is none — no CMS, nothing published yet, an outage — the
 * starter's static links render instead, so the chrome never disappears.
 *
 * Every CMS href renders through `SafeLink` (schema rules are not trusted at render time), and
 * items are keyed by their Studio `_key`, never by href — two items may legitimately share one.
 *
 * Window 3 may adopt this in `src/layouts/defaults.tsx` (REQUEST #178) so the shop follows too.
 */

export interface NavItemView {
  key: string;
  label: string;
  href: string;
  children?:
    { key: string; label: string; href: string; openInNewTab?: boolean | undefined }[] | undefined;
}

export function staticNavigation(ctx: ContentContext): NavItemView[] {
  return [
    { key: 'shop', label: ctx.t('nav.shop'), href: '/products' },
    { key: 'about', label: ctx.t('nav.about'), href: '/pages/about' },
  ];
}

export function navigationItems(
  nav: NavigationDocument | null,
  ctx: ContentContext,
): NavItemView[] {
  if (!nav || nav.items.length === 0) return staticNavigation(ctx);
  return nav.items.map((item, index) => ({
    key: item._key ?? `item-${index}`,
    label: item.label,
    href: item.href,
    children: item.children?.map(({ _key, label, href, openInNewTab }: CmsLink, childIndex) => ({
      key: _key ?? `child-${childIndex}`,
      label,
      href,
      ...(openInNewTab === undefined ? {} : { openInNewTab }),
    })),
  }));
}

export interface CmsHeaderProps {
  store: Store | null;
  navigation: NavigationDocument | null;
  ctx: ContentContext;
}

export function CmsHeader({ store, navigation, ctx }: CmsHeaderProps) {
  const { Logo } = getComponents();
  const items = navigationItems(navigation, ctx);

  return (
    <header className="border-b border-border">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-6 px-4">
        <Logo storeName={store?.name ?? ''} />
        <nav aria-label={ctx.t('nav.label')} className="flex items-center gap-6 text-sm">
          {items.map((item) => (
            <div key={item.key} className="group relative">
              <SafeLink href={item.href} className="hover:underline">
                {item.label}
              </SafeLink>
              {item.children && item.children.length > 0 ? (
                <ul className="absolute left-0 top-full z-10 hidden min-w-40 flex-col gap-2 rounded-md border border-border bg-background p-3 group-focus-within:flex group-hover:flex">
                  {item.children.map((child) => (
                    <li key={child.key}>
                      <SafeLink
                        href={child.href}
                        openInNewTab={child.openInNewTab}
                        className="hover:underline"
                      >
                        {child.label}
                      </SafeLink>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}
        </nav>
        <div className="flex items-center gap-4 text-sm">
          <Link href="/account" className="hover:underline">
            {ctx.t('nav.account')}
          </Link>
          <Link href="/cart" className="hover:underline">
            {ctx.t('nav.cart')}
          </Link>
        </div>
      </div>
    </header>
  );
}
