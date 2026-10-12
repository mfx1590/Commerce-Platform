import type { APIRequestContext } from '@playwright/test';
import { publishableKey } from './core-order';

/**
 * Core mode only (#430): the customers journey must not depend on customer rows a long-lived
 * database happens to hold — a freshly seeded core has none. Before it, the seeded customers-realm
 * user (`jane@example.com`, password = her first name, infra/keycloak/README.md) is linked to
 * brand-a through the **Store API**, the way a storefront does at sign-up: a customers-realm token
 * from the dev/CI `test-cli` client (which carries `store_code: brand-a`) plus the seeded brand-a
 * publishable key, `POST /store/customers` with names and marketing consent. Idempotent: 201 the
 * first time, 200 on every later run. The journey never erases this customer.
 */
export const CORE_CUSTOMER = {
  email: 'jane@example.com',
  firstName: 'Jane',
  lastName: 'Doe',
} as const;

/** The documented dev default (a plain word, infra/keycloak/README.md); override with the env. */
const CUSTOMER_PASSWORD = process.env.E2E_CUSTOMER_PASSWORD ?? 'jane';

export async function registerCoreCustomer(
  request: APIRequestContext,
  coreUrl: string,
): Promise<void> {
  const keycloak = process.env.KEYCLOAK_URL ?? 'http://localhost:8180';
  const token = await request.post(`${keycloak}/realms/customers/protocol/openid-connect/token`, {
    form: {
      grant_type: 'password',
      client_id: 'test-cli',
      username: CORE_CUSTOMER.email,
      password: CUSTOMER_PASSWORD,
      scope: 'openid',
    },
  });
  if (!token.ok()) throw new Error(`customers-realm token → ${token.status()}`);
  const { access_token: accessToken } = (await token.json()) as { access_token: string };

  const registered = await request.post(`${coreUrl}/store/customers`, {
    headers: {
      'X-Publishable-Key': publishableKey(),
      Authorization: `Bearer ${accessToken}`,
    },
    data: {
      email: CORE_CUSTOMER.email,
      first_name: CORE_CUSTOMER.firstName,
      last_name: CORE_CUSTOMER.lastName,
      marketing_consent: true,
    },
  });
  if (registered.status() !== 201 && registered.status() !== 200) {
    throw new Error(`Store API POST /store/customers → ${registered.status()}`);
  }
}
