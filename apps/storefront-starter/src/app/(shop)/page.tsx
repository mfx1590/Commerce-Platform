import { Badge, buttonVariants, Card, CardContent, CardHeader, CardTitle } from '@platform/ui';
import Link from 'next/link';
import { getStoreOrNull } from '@/lib/store';

export default async function HomePage() {
  const store = await getStoreOrNull();

  if (!store) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Store API not reachable</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          <p>
            The storefront could not load <code>GET /store</code>. Start the Prism mock with{' '}
            <code>pnpm mock</code> (or the whole stack with <code>pnpm dev</code>) and reload.
          </p>
          <p className="mt-2">
            The client reads <code>STORE_API_URL</code>, falling back to <code>MOCK_API_URL</code>{' '}
            and then <code>http://localhost:4010</code>.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-10">
      <section className="flex flex-col items-start gap-4">
        <Badge variant="outline">{store.sales_channel.type}</Badge>
        <h1 className="text-4xl font-bold leading-tight">{store.name}</h1>
        <p className="max-w-prose text-muted-foreground">
          A starter storefront rendering live data from the Store API. Every brand app is generated
          from this template and overrides tokens, slots and route files — never the shared kit.
        </p>
        {/* A link that looks like a button: an <a> inside a <button> would be invalid HTML. */}
        <Link href="/products" className={buttonVariants({ size: 'lg' })}>
          Shop all products
        </Link>
      </section>

      <section aria-labelledby="store-facts">
        <h2 id="store-facts" className="mb-4 text-xl font-semibold">
          This store
        </h2>
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="Code" value={store.code} />
          <Fact label="Ships to" value={store.default_country} />
          <Fact
            label="Currencies"
            value={store.currencies.join(', ')}
            hint={`default ${store.default_currency}`}
          />
          <Fact
            label="Locales"
            value={store.locales.join(', ')}
            hint={`default ${store.default_locale}`}
          />
        </dl>
      </section>
    </div>
  );
}

function Fact({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <dt className="text-sm text-muted-foreground">{label}</dt>
        <dd className="mt-1 text-lg font-medium">{value}</dd>
        {hint === undefined ? null : <dd className="text-sm text-muted-foreground">{hint}</dd>}
      </CardContent>
    </Card>
  );
}
