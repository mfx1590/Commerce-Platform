import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: {
      // the Postgres audit sink test (test/pg-audit.test.ts) migrates a throwaway database; 127.0.0.1, not
      // localhost (Docker's IPv6 loopback proxy)
      DATABASE_URL:
        process.env.DATABASE_URL ?? 'postgres://platform:platform@127.0.0.1:5433/platform',
      DATABASE_URL_APP:
        process.env.DATABASE_URL_APP ??
        'postgres://platform_app:platform_app@127.0.0.1:5433/platform',
    },
  },
});
