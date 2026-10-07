import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
} from '@playwright/test';
import {
  AGAINST_CORE,
  BACKEND,
  CHECKOUT_STEP,
  JOURNEY_TIMEOUT,
  NAVIGATION_TIMEOUT,
  SERVER_ACTION_TIMEOUT,
  advanceToReview,
  clickWhenReady,
  openPurchasableProduct,
} from './support/journey';
import { e2eServerEnv } from '../scripts/e2e-env.mjs';
import { storeApiConfigFromEnv } from '../src/lib/store-api/config';

/**
 * #372: the customer sees the order's real status as the shop works on it. The run places an order
 * (invoice), then ships and delivers it **through the Admin API as the seeded `operations` user** —
 * createShipment → pickShipment → packShipment → updateShipment {shipped} → updateShipment
 * {delivered} (no label: `buyShipmentLabel` is 422 for the manual carrier) — and reads the status the
 * confirmation page renders from `Order.status`: `processing` once shipped, `completed` once
 * delivered. Nothing is worked out in the browser; the core moves the order (#371).
 *
 * Core only. On the mock the order cannot move, so the spec prints one line saying why and skips.
 * Brand A runs it in its core leg after the sync.
 *
 * Staff credentials are the dev realm's seeded fixture (`infra/keycloak/README.md`: password =
 * username; the `test-cli` client has the password grant in dev and CI only), overridable with
 * `E2E_STAFF_USERNAME` / `E2E_STAFF_PASSWORD`.
 */

const SKIP_REASON = AGAINST_CORE
  ? null
  : `no core (this run is against ${BACKEND}; set E2E_STORE_API_URL)`;

const CORE_URL = (process.env.E2E_STORE_API_URL ?? '').replace(/\/$/, '');
const KEYCLOAK_URL = process.env.KEYCLOAK_URL ?? 'http://localhost:8180';
const STAFF = {
  username: process.env.E2E_STAFF_USERNAME ?? 'operations',
  password: process.env.E2E_STAFF_PASSWORD ?? 'operations',
};
/** The country of the address the journey enters (`completeAddressStep`). */
const DESTINATION_COUNTRY = 'NL';

test.beforeAll(() => {
  if (SKIP_REASON !== null) console.info(`[e2e] order-lifecycle skipped: ${SKIP_REASON}`);
});

test.beforeEach(() => {
  test.skip(SKIP_REASON !== null, `order lifecycle skipped: ${SKIP_REASON ?? ''}`);
  test.setTimeout(JOURNEY_TIMEOUT);
});

async function staffApi(): Promise<APIRequestContext> {
  const keycloak = await playwrightRequest.newContext();
  const response = await keycloak.post(
    `${KEYCLOAK_URL}/realms/staff/protocol/openid-connect/token`,
    {
      form: { grant_type: 'password', client_id: 'test-cli', ...STAFF },
    },
  );
  expect(response.ok(), `a staff token for ${STAFF.username} (staff realm, test-cli)`).toBe(true);
  const { access_token: token } = (await response.json()) as { access_token: string };
  await keycloak.dispose();
  return playwrightRequest.newContext({
    baseURL: CORE_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

/**
 * The body of a successful call, or a failed assertion naming the call, the HTTP status and the
 * contract's error `code` / `message` — never the raw body, which could carry an order's personal
 * data (#382; PII-free assertion messages, review of #375).
 */
async function json<T>(
  response: Awaited<ReturnType<APIRequestContext['get']>>,
  what: string,
): Promise<T> {
  if (!response.ok()) {
    let reason = '';
    try {
      const body = (await response.json()) as { code?: unknown; message?: unknown };
      reason = [body.code, body.message].filter((part) => typeof part === 'string').join(': ');
    } catch {
      reason = '(no JSON error body)';
    }
    expect(response.ok(), `${what}: HTTP ${response.status()} ${reason}`).toBe(true);
  }
  return (await response.json()) as T;
}

/**
 * The publishable key **the app under test uses**, resolved by the app's own code from the
 * environment the e2e server hands it (#382): `STORE_PUBLISHABLE_KEY` when the run sets it, else the
 * starter's default — which is what brand A's core leg runs with. Reading the variable directly sent
 * an empty key whenever the run relied on the default, and the store id came back undefined.
 */
function appPublishableKey(): string {
  return storeApiConfigFromEnv(e2eServerEnv(process.env)).publishableKey;
}

interface Warehouse {
  id: string;
  country: string;
  is_active: boolean;
  priority: number;
}

/** The core's routing for an order with no store override: the destination country, else the lowest priority. */
function routedWarehouse(warehouses: Warehouse[]): Warehouse {
  const active = warehouses.filter((warehouse) => warehouse.is_active);
  const byPriority = [...active].sort((a, b) => a.priority - b.priority);
  const local = byPriority.find((warehouse) => warehouse.country === DESTINATION_COUNTRY);
  const chosen = local ?? byPriority[0];
  expect(chosen, 'an active warehouse to ship from').toBeDefined();
  return chosen!;
}

test('the confirmation shows the order processing once shipped and completed once delivered', async ({
  page,
}) => {
  // ── The customer places an order.
  await openPurchasableProduct(page);
  await clickWhenReady(page, page.getByRole('button', { name: 'Add to cart' }));
  await expect(page).toHaveURL(/\/en-GB\/cart$/, { timeout: SERVER_ACTION_TIMEOUT });
  await clickWhenReady(page, page.getByRole('link', { name: 'Checkout' }));
  await expect(page).toHaveURL(CHECKOUT_STEP, { timeout: NAVIGATION_TIMEOUT });
  await advanceToReview(page, `e2e-lifecycle+${Date.now().toString(36)}@example.com`);
  await clickWhenReady(page, page.getByRole('button', { name: 'Place order' }));
  await expect(page).toHaveURL(/\/en-GB\/orders\/[^/]+$/, { timeout: SERVER_ACTION_TIMEOUT });

  const confirmation = page.getByTestId('order-confirmation');
  const orderId = (await confirmation.getAttribute('data-order-id')) ?? '';
  const orderNumber = (await confirmation.getAttribute('data-order-number')) ?? '';
  expect(orderId, 'the confirmation names the order').not.toBe('');
  await expect(confirmation, 'a new order is not yet being fulfilled').not.toHaveAttribute(
    'data-order-status',
    /processing|completed/,
  );

  // ── The shop ships it, as the operations user, through the Admin API.
  const store = await json<{ id: string }>(
    await page.request.get(`${CORE_URL}/store`, {
      headers: { 'X-Publishable-Key': appPublishableKey() },
    }),
    'GET /store',
  );
  expect(store.id, 'GET /store names the store the order belongs to').toMatch(/^[0-9a-f-]{36}$/i);
  const admin = await staffApi();
  const order = await json<{ items: { id: string; quantity: number }[] }>(
    await admin.get(`/admin/stores/${store.id}/orders/${orderId}`),
    'getOrder',
  );
  const { items: warehouses } = await json<{ items: Warehouse[] }>(
    await admin.get('/admin/warehouses'),
    'listWarehouses',
  );
  const shipment = await json<{ id: string }>(
    await admin.post(`/admin/stores/${store.id}/orders/${orderId}/shipments`, {
      data: {
        warehouse_id: routedWarehouse(warehouses).id,
        carrier: 'manual',
        items: order.items.map((item) => ({
          order_line_item_id: item.id,
          quantity: item.quantity,
        })),
      },
    }),
    'createShipment',
  );
  await json(await admin.post(`/admin/shipments/${shipment.id}/pick`), 'pickShipment');
  await json(
    await admin.post(`/admin/shipments/${shipment.id}/pack`, { data: {} }),
    'packShipment',
  );
  await json(
    await admin.patch(`/admin/shipments/${shipment.id}`, { data: { status: 'shipped' } }),
    'updateShipment shipped',
  );

  // ── Shipped: the customer's page says so — the order's own status, as text.
  await page.reload();
  await expect(confirmation).toHaveAttribute('data-order-status', 'processing');
  await expect(page.getByTestId('order-status')).toHaveText('Status: Processing');
  console.info(
    `[e2e] order ${orderNumber}: shipped → the confirmation shows "Processing", on ${BACKEND}`,
  );

  // ── Delivered.
  await json(
    await admin.patch(`/admin/shipments/${shipment.id}`, { data: { status: 'delivered' } }),
    'updateShipment delivered',
  );
  await page.reload();
  await expect(confirmation).toHaveAttribute('data-order-status', 'completed');
  await expect(page.getByTestId('order-status')).toHaveText('Status: Completed');
  console.info(
    `[e2e] order ${orderNumber}: delivered → the confirmation shows "Completed", on ${BACKEND}`,
  );

  await admin.dispose();
});
