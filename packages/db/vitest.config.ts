import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://platform:platform@localhost:5433/platform',
      DATABASE_URL_APP:
        process.env.DATABASE_URL_APP ?? 'postgres://platform_app:platform_app@localhost:5433/platform',
    },
  },
});
