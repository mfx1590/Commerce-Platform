import { defineConfig } from 'vitest/config';

// `test/core-month.test.ts` builds its own throwaway database through @platform/db/testing. Loopback is 127.0.0.1 on
// purpose (Docker's IPv6 proxy dies while IPv4 keeps working), and turbo strips DATABASE_URL* from the test
// environment, so both URLs are set here.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ?? 'postgres://platform:platform@127.0.0.1:5433/platform',
      DATABASE_URL_APP:
        process.env.DATABASE_URL_APP ??
        'postgres://platform_app:platform_app@127.0.0.1:5433/platform',
    },
  },
});
