import { expect, test, type Page } from '@playwright/test';
import { BACKEND, hydrated, readCards } from './support/journey';

/**
 * #327: an e2e run never leaves the machine for an image. `scripts/e2e-server.mjs` builds with
 * `E2E_LOCAL_IMAGES=1`, and `ProductImage` then sends every remote image — the seed's picsum
 * thumbnails against the core, Cloudinary in Prism's examples — to `/e2e-placeholder.svg`.
 *
 * Asserted three ways, presence first so it cannot pass on a page with no images: the listing and a
 * product page show product images; every one of them is the placeholder; and no request the
 * browser made in the meantime went to a host other than this app — so neither the browser nor the
 * image optimiser (`/_next/image?url=https…`) fetched anything remote.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function watchRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => seen.push(request.url()));
  return seen;
}

async function expectOnlyPlaceholders(page: Page, where: string): Promise<void> {
  const images = page.locator('main img');
  expect(await images.count(), `${where} on ${BACKEND} shows product images`).toBeGreaterThan(0);
  for (const src of await images.evaluateAll((elements) =>
    elements.map(
      (element) => (element as HTMLImageElement).currentSrc || element.getAttribute('src'),
    ),
  )) {
    expect(src, `${where}: every image is the local placeholder`).toContain('/e2e-placeholder.svg');
  }
}

test('no image request leaves the machine — listing and product page', async ({ page }) => {
  const requests = watchRequests(page);

  await page.goto('/en-GB/products');
  await expect(page.getByRole('heading', { level: 1, name: 'All products' })).toBeVisible();
  await hydrated(page);
  await expectOnlyPlaceholders(page, 'the listing');

  const [first] = await readCards(page);
  expect(first, 'the listing has a product to open').toBeDefined();
  await page.goto(`/en-GB/products/${first!.handle}`);
  await hydrated(page);
  await expectOnlyPlaceholders(page, 'the product page');

  // http(s) only: `data:` and `blob:` URLs are not requests to anywhere.
  const remote = requests.filter(
    (url) => /^https?:/i.test(url) && !LOCAL_HOSTS.has(new URL(url).hostname),
  );
  expect(remote, 'requests to a host other than this app').toEqual([]);
  const proxied = requests.filter((url) => /\/_next\/image\?url=https?%3A/i.test(url));
  expect(proxied, 'remote images proxied through the optimiser').toEqual([]);
});
