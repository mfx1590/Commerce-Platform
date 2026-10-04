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
