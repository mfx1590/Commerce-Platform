import type { NavItem } from '@/lib/nav/navigation';

/** A section is current for its own path and anything beneath it (`/…/catalog/some-product`). */
export function isActivePath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function activeItemId(pathname: string, items: readonly NavItem[]): string | null {
  return items.find((item) => isActivePath(pathname, item.href))?.id ?? null;
}
