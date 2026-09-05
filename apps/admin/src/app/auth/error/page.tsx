import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';

/**
 * The only page outside the middleware's gate. Issue #29 replaces this with the shared state
 * panels; until then it exists so a failed sign-in shows a reason and a next action instead of a
 * redirect loop.
 */
export default async function AuthErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen max-w-lg items-center px-6">
      <Card className="w-full">
        <CardHeader
          title="Could not sign you in"
          description="The staff realm rejected or could not complete the sign-in."
        />
        <CardBody className="space-y-4">
          <p className="text-muted text-sm">{reason ?? 'No further detail was returned.'}</p>
          <Link href="/api/auth/login">
            <Button>Try again</Button>
          </Link>
        </CardBody>
      </Card>
    </main>
  );
}
