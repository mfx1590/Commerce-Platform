import type { ReactNode } from 'react';
import { Link } from '@/i18n/navigation';
import { safeHref } from '../safe-href';

/**
 * The one place a CMS `href` becomes an element. Internal paths go through next-intl's Link,
 * external URLs through `<a rel="noopener noreferrer">`, and anything unsafe renders its children
 * as a plain `<span>` — the label survives, the link does not.
 */
export function SafeLink({
  href,
  children,
  className,
  openInNewTab,
}: {
  href: string | undefined | null;
  children: ReactNode;
  className?: string | undefined;
  openInNewTab?: boolean | undefined;
}) {
  const safe = safeHref(href);
  if (safe.kind === 'internal') {
    return (
      <Link href={safe.href} className={className}>
        {children}
      </Link>
    );
  }
  if (safe.kind === 'external') {
    return (
      <a
        href={safe.href}
        className={className}
        rel="noopener noreferrer"
        target={openInNewTab ? '_blank' : undefined}
      >
        {children}
      </a>
    );
  }
  return <span className={className}>{children}</span>;
}
