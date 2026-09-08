/**
 * Where the Admin API base URL comes from.
 *
 * Two variables now name the same thing — `ADMIN_API_URL` (the real core) and `MOCK_ADMIN_API_URL`
 * (Prism) — and the order between them is the whole feature: an operator sets `ADMIN_API_URL` in a
 * `.env` that already carries the mock variable and expects the core to win. Get the order backwards
 * and nothing crashes, the app just keeps talking to the mock, which is exactly the kind of bug that
 * survives a manual smoke test.
 */
import { describe, expect, it } from 'vitest';
import { MOCK_URLS } from '@platform/contracts';
import { resolveAdminApiUrl } from '@/lib/env';

const CORE = 'http://localhost:9000';
const MOCK = 'http://localhost:4011';

describe('resolveAdminApiUrl precedence', () => {
  it('prefers ADMIN_API_URL when both are set', () => {
    expect(resolveAdminApiUrl({ ADMIN_API_URL: CORE, MOCK_ADMIN_API_URL: MOCK })).toEqual(CORE);
  });

  it('uses ADMIN_API_URL when it is the only one set', () => {
    expect(resolveAdminApiUrl({ ADMIN_API_URL: CORE })).toEqual(CORE);
  });

  it('falls back to MOCK_ADMIN_API_URL when ADMIN_API_URL is absent', () => {
    expect(resolveAdminApiUrl({ MOCK_ADMIN_API_URL: MOCK })).toEqual(MOCK);
  });

  it('falls back to MOCK_ADMIN_API_URL when ADMIN_API_URL is empty', () => {
    // Shells make this easy to produce: `ADMIN_API_URL=` in a .env file is set, but to nothing.
    // Treating it as "not set" is what the rest of this module already does.
    expect(resolveAdminApiUrl({ ADMIN_API_URL: '', MOCK_ADMIN_API_URL: MOCK })).toEqual(MOCK);
  });

  it("defaults to the contracts package's mock URL when neither is set", () => {
    expect(resolveAdminApiUrl({})).toEqual(MOCK_URLS.admin);
    expect(resolveAdminApiUrl({})).toEqual('http://localhost:4011');
  });

  it('defaults when both are empty', () => {
    expect(resolveAdminApiUrl({ ADMIN_API_URL: '', MOCK_ADMIN_API_URL: '' })).toEqual(
      MOCK_URLS.admin,
    );
  });
});

describe('resolveAdminApiUrl normalisation and validation', () => {
  it('drops a trailing slash, so path joins do not double up', () => {
    expect(resolveAdminApiUrl({ ADMIN_API_URL: 'http://localhost:9000/' })).toEqual(CORE);
  });

  it('accepts https', () => {
    expect(resolveAdminApiUrl({ ADMIN_API_URL: 'https://admin.example.com' })).toEqual(
      'https://admin.example.com',
    );
  });

  it('rejects a value that is not a URL, naming the variable that is wrong', () => {
    expect(() => resolveAdminApiUrl({ ADMIN_API_URL: 'localhost:9000' })).toThrow(/ADMIN_API_URL/);
  });

  it('rejects a non-http scheme', () => {
    expect(() => resolveAdminApiUrl({ ADMIN_API_URL: 'ftp://localhost:9000' })).toThrow(
      /http:\/\/ or https:\/\//,
    );
  });

  it('names MOCK_ADMIN_API_URL when that is the broken one', () => {
    expect(() => resolveAdminApiUrl({ MOCK_ADMIN_API_URL: 'not-a-url' })).toThrow(
      /MOCK_ADMIN_API_URL/,
    );
  });
});
