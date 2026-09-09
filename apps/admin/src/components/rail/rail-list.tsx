'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { NavItem } from '@/lib/nav/navigation';
import { isActivePath } from './active';
import styles from './medusa-rail.module.css';

/**
 * The plain fallback: the same sections as the serpents, as an ordinary list of links with
 * `aria-current`. Shown under `prefers-reduced-motion`, on touch devices by default, or when the
 * user asks for it — and it is what a screen reader gets either way.
 *
 * Which sections reach this component is decided on the server; it only marks the current one.
 * A client component sees nothing but labels and hrefs — no principal, no token.
 */
export function RailList({ label, items }: { label: string; items: readonly NavItem[] }) {
  const pathname = usePathname();

  if (items.length === 0) return null;

  return (
    <nav aria-label={label} className={styles.list}>
      <ul>
        {items.map((item) => {
          const active = isActivePath(pathname, item.href);
          return (
            <li key={item.id}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={styles.listLink}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
