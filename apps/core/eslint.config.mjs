// apps/core ESLint config: the root rules plus this app's own guard. Run with `pnpm --filter @platform/core lint`
// (the root `pnpm lint` uses only the root config; nested flat configs are not picked up automatically).
import root from '../../eslint.config.mjs';

export default [
  ...root,
  {
    files: ['**/*.ts'],
    ignores: ['src/lib/db.ts'],
    rules: {
      // Every database access goes through src/lib/db.ts (@platform/db scoped clients, RLS). No handler,
      // module or script opens its own pg connection.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'pg',
              message:
                'Import tenantClient / organizationClient from src/lib/db.ts; never open a pg connection elsewhere.',
            },
          ],
          patterns: ['pg/*'],
        },
      ],
    },
  },
];
