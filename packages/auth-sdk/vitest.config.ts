import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const pkg = (p: string) => resolve(__dirname, '..', p);

export default defineConfig({
  resolve: {
    // Lets apps/core/src/modules/hq-rbac (tested from here, no deps of its own) resolve the workspace packages.
    alias: [
      { find: '@platform/auth-sdk', replacement: resolve(__dirname, 'src/index.ts') },
      { find: '@platform/db/testing', replacement: pkg('db/src/testing.ts') },
      { find: '@platform/db', replacement: pkg('db/src/index.ts') },
      { find: '@platform/contracts', replacement: pkg('contracts/src/index.ts') },
    ],
  },
  test: {
    include: ['test/**/*.test.ts', '../../apps/core/src/modules/hq-rbac/test/**/*.test.ts'],
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
