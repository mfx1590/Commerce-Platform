'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { NavItem } from '@/lib/nav/navigation';
import { cn } from '@/lib/utils';

/**
 * Which sections reach this component is decided on the server; this only marks the current one.
 * A client component sees nothing but labels and hrefs — no principal, no token.
 */
export function SideNav({ label, items }: { label: string; items: NavItem[] }) {
  const pathname = usePathname();

  if (items.length === 0) return null;

  return (
    <nav aria-label={label} className="space-y-1">
      <p className="text-muted px-3 pb-1 text-xs font-semibold tracking-wide uppercase">{label}</p>
      <ul>
        {items.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <li key={item.id}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'block rounded-md px-3 py-1.5 text-sm transition',
                  active ? 'bg-accent/10 text-accent font-medium' : 'text-ink hover:bg-canvas',
                )}
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
