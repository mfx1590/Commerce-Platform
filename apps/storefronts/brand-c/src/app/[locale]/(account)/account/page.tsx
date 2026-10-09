import { Badge, buttonVariants } from '@platform/ui';
import type { Metadata } from 'next';
import { Link } from '@/i18n/navigation';
import { AddAddressForm, ProfileForm, SignOutButton } from '@/components/account-forms';
import { AddressCard } from '@/components/order-summary';
import { requireCustomerToken } from '@/lib/auth/require-customer';
import { storeApi } from '@/lib/store-api';

export const metadata: Metadata = { title: 'Your account' };

/** Personal data: never cached, never prerendered. */
export const dynamic = 'force-dynamic';

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { error } = await searchParams;
  const token = await requireCustomerToken('/account');

  const [customer, addresses] = await Promise.all([
    storeApi().getMe({ token, cache: 'no-store' }),
    storeApi().listMyAddresses({ token, cache: 'no-store' }),
  ]);

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-bold">Your account</h1>
          <p className="text-muted-foreground">{customer.email}</p>
          <Badge variant="neutral" className="mt-1 self-start">
            {customer.status}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/account/orders" className={buttonVariants({ variant: 'outline' })}>
            Order history
          </Link>
          <SignOutButton />
        </div>
      </header>

      {error === 'sign_in_failed' ? (
        <p
          role="alert"
          className="rounded-md border border-destructive p-3 text-sm text-destructive"
        >
          Sign-in did not complete. Please try again.
        </p>
      ) : null}

      <section aria-labelledby="profile" className="flex flex-col gap-4">
        <h2 id="profile" className="text-xl font-semibold">
          Profile
        </h2>
        <ProfileForm customer={customer} />
      </section>

      <section aria-labelledby="addresses" className="flex flex-col gap-4">
        <h2 id="addresses" className="text-xl font-semibold">
          Addresses
        </h2>
        {addresses.items.length === 0 ? (
          <p className="text-muted-foreground">No saved addresses yet.</p>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2">
            {addresses.items.map((address) => (
              <li key={address.id} className="rounded-lg border border-border p-4">
                <AddressCard
                  title={`${address.first_name} ${address.last_name}`}
                  address={address}
                />
                {address.is_default_shipping ? (
                  <Badge variant="neutral" className="mt-2">
                    Default delivery
                  </Badge>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <AddAddressForm />
      </section>
    </div>
  );
}
