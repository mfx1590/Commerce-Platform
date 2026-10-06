import { describe, expect, it } from 'vitest';
import { e2eServerEnv } from '../scripts/e2e-env.mjs';

/**
 * Which backend an e2e run talks to must not depend on what the shell exports (review of #316).
 * With `STORE_API_URL` exported — the `.env.example` value points at the core — a run without
 * `E2E_STORE_API_URL` called itself a mock run, skipped the core-only tests "because Prism", and
 * spent real seed stock while logging "on the Prism mock".
 */
describe('e2eServerEnv', () => {
  const CORE = 'http://localhost:9000';
  const MOCK = 'http://localhost:4010';

  it('a mock run never inherits STORE_API_URL from the shell', () => {
    const env = e2eServerEnv({ STORE_API_URL: CORE, MOCK_API_URL: MOCK, PORT: '3100' });

    expect('STORE_API_URL' in env).toBe(false);
    expect(env).toMatchObject({ MOCK_API_URL: MOCK, PORT: '3100' });
  });

  it('treats an empty E2E_STORE_API_URL as a mock run too', () => {
    const env = e2eServerEnv({ E2E_STORE_API_URL: '', STORE_API_URL: CORE });
    expect('STORE_API_URL' in env).toBe(false);
  });

  it('a core run talks to the backend named for the run, whatever the shell exports', () => {
    const env = e2eServerEnv({
      E2E_STORE_API_URL: 'http://127.0.0.1:9000',
      STORE_API_URL: 'https://staging.example',
    });
    expect(env.STORE_API_URL).toBe('http://127.0.0.1:9000');
  });

  it('turns on local images for every run, mock or core (#327)', () => {
    expect(e2eServerEnv({}).E2E_LOCAL_IMAGES).toBe('1');
    expect(e2eServerEnv({ E2E_STORE_API_URL: CORE }).E2E_LOCAL_IMAGES).toBe('1');
  });

  it('allows pay-on-invoice for every run, so a run without a Stripe key can check out (#358)', () => {
    expect(e2eServerEnv({}).STOREFRONT_ALLOW_INVOICE).toBe('1');
  });

  it('does not touch the environment it was given', () => {
    const shell = { STORE_API_URL: CORE };
    e2eServerEnv(shell);
    expect(shell).toEqual({ STORE_API_URL: CORE });
  });
});
