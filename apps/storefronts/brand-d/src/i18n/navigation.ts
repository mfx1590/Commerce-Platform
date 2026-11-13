import { createNavigation } from 'next-intl/navigation';
import { routing } from './routing';

/**
 * Locale-aware navigation. Pages and components import `Link` from here instead of `next/link`, so
 * every internal href keeps the customer in the locale they are browsing without a single call site
 * having to remember the prefix.
 */
export const { Link, redirect, usePathname, useRouter, getPathname } = createNavigation(routing);
