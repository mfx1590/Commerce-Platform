import { keycloakOrigin } from '@/lib/csp';
import { assertLocalImagesAllowed, localImagesEnabled } from '@/lib/e2e-images';

/**
 * A build that shows placeholders instead of products can never serve customers. Exits rather than
 * throws: the point is that the process does not come up, not that a log line appears beside a
 * running server.
 */
export function refuseTestBuildOutsideLoopback(
  env: Readonly<Record<string, string | undefined>> = process.env,
  exit: (code: number) => never = process.exit,
): void {
  try {
    assertLocalImagesAllowed(localImagesEnabled(), env.SITE_URL);
  } catch (error) {
    console.error(`[storefront] ${(error as Error).message}`);
    exit(1);
  }
}

/**
 * A production server without a usable `KEYCLOAK_URL` cannot build its Content-Security-Policy
 * (`form-action` needs the identity provider's origin; `src/lib/csp.ts` throws rather than guess),
 * so every page would answer 500 while `/health` stayed green (#790). It does not come up instead.
 * Skipped during `next build`, which renders no request, and outside production.
 */
export function refuseProductionWithoutKeycloak(
  env: Readonly<Record<string, string | undefined>> = process.env,
  exit: (code: number) => never = process.exit,
): void {
  if (env.NODE_ENV !== 'production' || env.NEXT_PHASE === 'phase-production-build') return;
  try {
    keycloakOrigin(env.KEYCLOAK_URL, true);
  } catch (error) {
    console.error(`[storefront] ${(error as Error).message}`);
    exit(1);
  }
}
