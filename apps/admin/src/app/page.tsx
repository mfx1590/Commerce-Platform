import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { getSession } from '@/lib/auth/current-session';
import { getMe } from '@/lib/api/admin';

export const dynamic = 'force-dynamic';

/**
 * Proof that the whole chain works: Keycloak session → server-side token → typed Admin API call.
 * Issue #25 turns this `Principal` into the real navigation and store switcher; the raw dump below
 * is deliberately temporary.
 */
export default async function HomePage() {
  const session = await getSession();
  const me = await getMe();

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-6 py-10">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Admin</h1>
          <p className="text-muted mt-1 text-sm">
            Signed in as {session?.user.displayName ?? 'unknown'} ({session?.user.username ?? '—'})
          </p>
        </div>
        <form action="/api/auth/logout" method="post">
          <Button type="submit" variant="secondary">
            Sign out
          </Button>
        </form>
      </header>

      {!me.ok ? (
        <Card>
          <CardHeader
            title={`Admin API returned ${me.status}`}
            description="Phase 1 talks to the Prism mock; start it with `pnpm mock`."
          />
          <CardBody className="space-y-1 text-sm">
            <p>
              <span className="text-muted">code</span> {me.error.code}
            </p>
            <p>
              <span className="text-muted">message</span> {me.error.message}
            </p>
          </CardBody>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader
              title={me.data.organization.name}
              description={`Organization ${me.data.organization.slug}`}
              action={
                me.data.organization_relations.length === 0 ? (
                  <Badge>no HQ relations</Badge>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {me.data.organization_relations.map((relation) => (
                      <Badge key={relation} tone="accent">
                        {relation}
                      </Badge>
                    ))}
                  </div>
                )
              }
            />
            <CardBody className="text-sm">
              <p>
                <span className="text-muted">user</span> {me.data.user.display_name} ·{' '}
                {me.data.user.email}
              </p>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Stores"
              description="The store switcher in issue #25 lists exactly these."
            />
            <CardBody>
              {me.data.stores.length === 0 ? (
                <p className="text-muted text-sm">
                  No stores. This principal only has HQ-level access.
                </p>
              ) : (
                <ul className="divide-line divide-y">
                  {me.data.stores.map((store) => (
                    <li
                      key={store.store_id}
                      className="flex items-center justify-between gap-4 py-3"
                    >
                      <div>
                        <p className="text-sm font-medium">{store.name}</p>
                        <p className="text-muted font-mono text-xs">{store.code}</p>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {store.relations.map((relation) => (
                          <Badge key={relation}>{relation}</Badge>
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </>
      )}
    </main>
  );
}
