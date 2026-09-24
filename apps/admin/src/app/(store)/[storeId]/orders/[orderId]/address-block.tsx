import type { AdminComponents } from '@/lib/api/admin-client';

type Address = AdminComponents['Address'];

/**
 * A postal address as the contract shapes it. Only six fields are `required`; the rest are
 * `[string, 'null']` *and* optional, and the real core omits them rather than sending `null` —
 * which the first run against it showed as a literal "undefined" in the city line. So every
 * optional field is treated as absent when it is `null` **or** missing.
 *
 * Rendered in a server component only: the `support` gate on the screen is what stands between
 * this PII and the browser bundle, so it stays in server-rendered HTML rather than client props.
 */
export function AddressBlock({ title, address }: { title: string; address: Address }) {
  const present = (value: string | null | undefined): value is string =>
    typeof value === 'string' && value !== '';
  const cityLine = [address.postal_code, address.city].filter(present).join(' ');
  return (
    <div className="min-w-0">
      <h3 className="text-muted mb-1 text-xs tracking-wide uppercase">{title}</h3>
      <address className="text-sm not-italic">
        {address.first_name} {address.last_name}
        {present(address.company) && (
          <>
            <br />
            {address.company}
          </>
        )}
        <br />
        {address.line1}
        {present(address.line2) && (
          <>
            <br />
            {address.line2}
          </>
        )}
        <br />
        {cityLine}
        {present(address.region) ? `, ${address.region}` : ''}
        <br />
        {address.country}
        {present(address.phone) && (
          <>
            <br />
            {address.phone}
          </>
        )}
      </address>
    </div>
  );
}
