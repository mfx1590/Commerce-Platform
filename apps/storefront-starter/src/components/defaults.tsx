import Link from 'next/link';
import type { ComponentSlots } from '@/lib/slots';

/** Wordmark. A brand usually replaces this with its own SVG or a `next/image` logo. */
function Logo({ storeName }: { storeName: string }) {
  return (
    <Link href="/" className="text-xl font-semibold tracking-tight">
      {storeName}
    </Link>
  );
}

/** Promo strip above the header. Off by default; a brand overrides it or drives it from the CMS. */
function Announcement() {
  return null;
}

export const defaultComponents: ComponentSlots = { Logo, Announcement };
