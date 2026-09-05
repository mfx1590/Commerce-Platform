import { defineConfig } from 'vitest/config';

// Same defaults as packages/db: a reachable Postgres (docker: pnpm compose:up → localhost:5433) as owner for
// fixtures and as platform_app for everything the application does. CI overrides both URLs (port 5432).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ?? 'postgres://platform:platform@localhost:5433/platform',
      DATABASE_URL_APP:
        process.env.DATABASE_URL_APP ??
        'postgres://platform_app:platform_app@localhost:5433/platform',
    },
  },
});
