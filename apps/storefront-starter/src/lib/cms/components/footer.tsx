import type { FooterDocument, Link as CmsLink } from '@platform/cms';
import { Link } from '@/i18n/navigation';
import type { Store } from '@/lib/store-api';
import type { ContentContext } from '../content';

/**
 * The footer for CMS-driven pages: link columns, legal links and social links from the CMS
 * `footer` document for the locale, with the copyright line always present. Without a document the
 * starter's minimal footer (copyright only) renders, so the page still ends properly.
 */

function FooterLink({ link }: { link: CmsLink }) {
  if (/^https?:\/\//.test(link.href)) {
    return (
      <a
        href={link.href}
        rel="noopener noreferrer"
        target={link.openInNewTab ? '_blank' : undefined}
        className="hover:underline"
      >
        {link.label}
      </a>
    );
  }
  return (
    <Link href={link.href} className="hover:underline">
      {link.label}
    </Link>
  );
}

function LinkList({ links }: { links: CmsLink[] }) {
  return (
    <ul className="flex flex-col gap-1">
      {links.map((link) => (
        <li key={link._key ?? link.href}>
          <FooterLink link={link} />
        </li>
      ))}
    </ul>
  );
}

export interface CmsFooterProps {
  store: Store | null;
  footer: FooterDocument | null;
  ctx: ContentContext;
  year?: number;
}

export function CmsFooter({ store, footer, ctx, year = new Date().getFullYear() }: CmsFooterProps) {
  const copyright =
    footer?.copyright ?? ctx.t('footer.copyright', { year, store: store?.name ?? '' });
  const columns = footer?.columns ?? [];
  const legal = footer?.legalLinks ?? [];
  const social = footer?.socialLinks ?? [];

  return (
    <footer aria-label={ctx.t('footer.label')} className="mt-16 border-t border-border">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-8 text-sm text-muted-foreground">
        {columns.length > 0 || legal.length > 0 || social.length > 0 ? (
          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {columns.map((column) => (
              <div key={column._key ?? column.heading}>
                <h2 className="mb-2 font-medium text-foreground">{column.heading}</h2>
                <LinkList links={column.links} />
              </div>
            ))}
            {legal.length > 0 ? (
              <div>
                <h2 className="mb-2 font-medium text-foreground">{ctx.t('footer.legal')}</h2>
                <LinkList links={legal} />
              </div>
            ) : null}
            {social.length > 0 ? (
              <div>
                <h2 className="mb-2 font-medium text-foreground">{ctx.t('footer.social')}</h2>
                <LinkList links={social} />
              </div>
            ) : null}
          </div>
        ) : null}
        <p>{copyright}</p>
      </div>
    </footer>
  );
}
