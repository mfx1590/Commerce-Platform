import { expect, test } from '@playwright/test';

/**
 * `/r/{code}` end to end (task 2.4).
 *
 * The unit tests cover the code and target rules; what only a browser can show is that the route is
 * reachable **without a locale prefix** — it depends on the middleware matcher excluding `/r/`, and
 * a matcher mistake would silently turn every referral link into a redirect to `/en-GB/r/...` and a
 * 404.
 */

const CODE = 'jane-autumn';

test('a referral link records the code and lands on the shop', async ({ page, context }) => {
  await context.clearCookies();

  const response = await page.goto(`/r/${CODE}`);
  expect(response?.status()).toBe(200);
  // No locale prefix on the way in; the destination redirects to the default locale as usual.
  await expect(page).toHaveURL(/\/en-GB$/);

  const cookie = (await context.cookies()).find((c) => c.name === 'sf_attribution');
  expect(cookie, 'the referral must be recorded').toBeDefined();
  const attribution = JSON.parse(decodeURIComponent(cookie!.value)) as {
    first: { ref: string; landing_path: string };
    last: { ref: string };
  };
  expect(attribution.first.ref).toBe(CODE);
  expect(attribution.first.landing_path).toBe(`/r/${CODE}`);
  // httpOnly: nothing in the browser needs it, and it must stay out of reach of any brand script.
  expect(cookie!.httpOnly).toBe(true);
});

test('the `to` target is honoured when it is on this site, and ignored when it is not', async ({
  page,
  context,
}) => {
  await context.clearCookies();
  await page.goto(`/r/${CODE}?to=%2Fen-GB%2Fproducts`);
  await expect(page).toHaveURL(/\/en-GB\/products$/);

  await context.clearCookies();
  // An absolute URL must not be followed: a referral link cannot become an open redirect.
  await page.goto(`/r/${CODE}?to=https%3A%2F%2Fexample.com%2Fowned`);
  await expect(page).toHaveURL(/\/en-GB$/);
});

test('the first touch survives a second referral', async ({ page, context }) => {
  await context.clearCookies();
  await page.goto(`/r/${CODE}`);
  await page.goto('/r/sam-winter');

  const cookie = (await context.cookies()).find((c) => c.name === 'sf_attribution');
  const attribution = JSON.parse(decodeURIComponent(cookie!.value)) as {
    first: { ref: string };
    last: { ref: string };
  };
  // Whoever actually acquired the customer keeps the credit; the last click is what closed it.
  expect(attribution.first.ref).toBe(CODE);
  expect(attribution.last.ref).toBe('sam-winter');
});

/**
 * The open redirect from the review of #273, end to end.
 *
 * URL parsing strips tab, newline and carriage return before parsing, so `?to=%2F%09%2Fevil.example`
 * used to resolve to `https://evil.example/` — on a link the brand publishes. Only a browser proves
 * the whole chain: the encoded parameter, the guard, and where the navigation actually ends up.
 */
test('a control-character target cannot redirect off this site', async ({ page, context }) => {
  for (const encoded of [
    '%2F%09%2Fevil.example',
    '%2F%0A%2Fevil.example',
    '%2F%0D%2Fevil.example',
  ]) {
    await context.clearCookies();
    await page.goto(`/r/${CODE}?to=${encoded}`);

    // Exactly the home page of this site, never evil.example.
    await expect(page).toHaveURL(/^http:\/\/(127\.0\.0\.1|localhost):\d+\/en-GB$/);
    expect(new URL(page.url()).hostname).not.toContain('evil');
  }
});
