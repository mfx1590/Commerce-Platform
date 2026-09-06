import { expect, test } from '@playwright/test';

/**
 * The journey the storefront exists to support, end to end against the Prism mock.
 *
 * The mock answers from the contract's examples and keeps no state, so the cart it returns after
 * the first line item already carries Jane's address and a delivery option (`CartWithItem`). The
 * journey therefore enters checkout at the payment step. Every step is still exercised for real:
 * the app reads the cart, decides the step, posts to a server action and follows the redirect.
 */
test('PLP → PDP → cart → checkout → confirmation', async ({ page }) => {
  await test.step('listing', async () => {
    await page.goto('/products');
    await expect(page.getByRole('heading', { level: 1, name: 'All products' })).toBeVisible();
    await page.getByRole('link', { name: 'Classic Tee' }).first().click();
  });

  await test.step('detail', async () => {
    await expect(page).toHaveURL(/\/products\/classic-tee$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Classic Tee' })).toBeVisible();
    // Rendered on the server from the resolved variant, before any hydration.
    await expect(page.getByTestId('price-value').first()).toContainText('19.99');
    await page.getByRole('button', { name: 'Add to cart' }).click();
  });

  await test.step('cart', async () => {
    await expect(page).toHaveURL(/\/cart$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Cart' })).toBeVisible();
    await expect(page.getByText('TEE-M-RED')).toBeVisible();
    await page.getByRole('link', { name: 'Checkout' }).click();
  });

  await test.step('checkout', async () => {
    // `/checkout` routes to whatever the cart still needs.
    await expect(page).toHaveURL(/\/checkout\/payment$/);
    await page.getByRole('button', { name: 'Continue to review' }).click();

    await expect(page).toHaveURL(/\/checkout\/review$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Review your order' })).toBeVisible();
    await expect(page.getByText('Keizersgracht 1')).toBeVisible();
    await page.getByRole('button', { name: 'Place order' }).click();
  });

  await test.step('confirmation', async () => {
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Thank you' })).toBeVisible();
    await expect(page.getByText('Order placed')).toBeVisible();
  });
});

test('checkout steps cannot be skipped', async ({ page }) => {
  // No cart at all: every checkout URL sends the customer back to the cart.
  await page.goto('/checkout/review');
  await expect(page).toHaveURL(/\/cart$/);
  await expect(page.getByRole('heading', { name: 'Your cart is empty' })).toBeVisible();
});

// A missing product cannot be exercised here: Prism answers `GET /store/products/{handle}` with the
// contract's example whatever the handle is, so every handle "exists". The PDP's `notFound()` path
// is covered by the `isNotFound` unit tests in test/store-api.test.ts instead.

test('the listing filters through the URL', async ({ page }) => {
  await page.goto('/products');
  await page.getByRole('link', { name: 'Price: low to high' }).click();
  await expect(page).toHaveURL(/sort=price_asc/);
  await expect(page.getByRole('heading', { level: 1, name: 'All products' })).toBeVisible();
});
