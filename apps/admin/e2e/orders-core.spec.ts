import { orderStatusMeaning } from '../src/lib/orders/lifecycle';
import { expect, test, type Page } from '@playwright/test';
import { AGAINST_CORE, stamped } from './api-mode';
import { placeCoreOrder, type PlacedOrder } from './core-order';
import { BRAND_A, signIn, signInAs } from './staff';

/**
 * Capture → refund and Buy label against the **real core** (#357, Integration 2a). Core mode only:
 * against Prism the order example has no authorised payment and no shipment, so these buttons are
 * covered by the unit tests and the Prism contract suite instead.
 *
 * Each journey works on an order it places itself (`placeCoreOrder`, #285) — never on seeded or
 * shared orders. When the core's provider or carrier is the manual one, the core answers 422
 * `provider_unsupported`, the screen says "not available", and the journey **skips with that
 * reason**: nothing failed, the test-mode provider simply cannot do it. With a provider/carrier
 * that can (Stripe / EasyPost test mode), it runs to the end.
 */
const CORE_URL = process.env.CORE_URL ?? 'http://localhost:9000';
const OPERATIONS = { username: 'operations', password: 'operations' };

async function openOrder(page: Page, placed: PlacedOrder) {
  await page
    .getByRole('table', { name: 'Orders' })
    .getByRole('link', { name: `#${placed.display_id}` })
    .click();
  await page.waitForURL(new RegExp(`/${BRAND_A}/orders/[0-9a-f-]{36}$`));
  await expect(page.getByRole('heading', { name: `Order #${placed.display_id}` })).toBeVisible();
}

test.describe('orders against the core: capture, refund, label', () => {
  test.skip(
    !AGAINST_CORE,
    'core mode only (E2E_API=core): Prism has no authorised payment or packed shipment',
  );

  test('store-admin captures the run order, then refunds part of it', async ({ page, request }) => {
    const placed = await placeCoreOrder(request, CORE_URL, stamped('capture'));
    await signIn(page, `/${BRAND_A}/orders`);
    await openOrder(page, placed);
    // The status the core reports for a placed order whose payment is authorised (#350: the manual
    // provider authorises at placement → `confirmed`). Exact sentence: `/authorised/` would also
    // match "not yet authorised" and pass on a `pending` order.
    await expect(page.getByTestId('order-status-meaning')).toHaveText(
      orderStatusMeaning('confirmed'),
    );

    const payments = page.getByRole('list', { name: 'Payments' });
    await payments.getByRole('button', { name: 'Capture' }).click();
    const question = page.getByRole('alertdialog', { name: 'Confirm capture' });
    await expect(question).toContainText('Capture the whole authorised');
    await question.getByRole('button', { name: 'Yes, capture' }).click();

    const unavailable = page.getByTestId('capture-unavailable');
    const captured = page.getByText('Payment captured.');
    await expect(unavailable.or(captured)).toBeVisible();
    test.skip(
      await unavailable.isVisible(),
      "core's payment provider is manual: capture is not available (422 provider_unsupported), so there is nothing to refund",
    );

    await page.reload();
    await expect(payments.getByText('captured')).toBeVisible();
    await page.getByRole('button', { name: 'Refund', exact: true }).click();
    await expect(page.getByText(/can still be refunded/)).toBeVisible();
    await page.getByRole('button', { name: /Yes, refund/ }).click();
    await expect(page.getByRole('status')).toHaveText(/Refund of .* requested/);
  });

  test('operations plans, picks and packs the run order, then buys its label', async ({
    page,
    request,
  }) => {
    const placed = await placeCoreOrder(request, CORE_URL, stamped('label'));
    await signInAs(page, OPERATIONS, `/${BRAND_A}/orders`);
    await openOrder(page, placed);

    await page.getByRole('button', { name: 'Fulfil' }).click();
    await page
      .getByRole('form', { name: 'Plan shipment' })
      .getByRole('button', { name: 'Yes, plan the shipment' })
      .click();
    await page.getByRole('button', { name: 'Pick' }).click();
    await page.getByRole('button', { name: 'Yes, start picking' }).click();
    await page.getByRole('button', { name: 'Pack', exact: true }).click();
    await page.getByRole('button', { name: 'Yes, mark packed' }).click();
    // Fulfilment started: the core moves the order to processing (#350).
    await expect(page.getByTestId('order-status-meaning')).toHaveText(
      orderStatusMeaning('processing'),
    );

    await page.getByRole('button', { name: 'Buy label' }).click();
    await expect(page.getByRole('alertdialog', { name: 'Confirm buying a label' })).toBeVisible();
    await page.getByRole('button', { name: 'Yes, buy label' }).click();

    const unavailable = page.getByTestId('label-unavailable');
    const label = page.getByRole('link', { name: 'Label' });
    await expect(unavailable.or(label)).toBeVisible();
    test.skip(
      await unavailable.isVisible(),
      "core's carrier is manual: buying a label is not available (422 provider_unsupported); tracking is attached with Update",
    );
    await expect(label).toHaveAttribute('href', /^https?:\/\//);
  });
});
