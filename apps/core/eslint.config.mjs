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
  {
    files: ['**/*.ts'],
    ignores: ['src/outbox/**'],
    rules: {
      // The transactional outbox (ADR 0003) has one writer: src/outbox/withEvents. Any other SQL that inserts
      // into the outbox table — in a template literal or a string — is a lint error.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TemplateElement[value.raw=/insert\\s+into\\s+"?outbox/i]',
          message: 'Write to the outbox through withEvents() from src/outbox only (ADR 0003).',
        },
        {
          selector: 'Literal[value=/insert\\s+into\\s+"?outbox/i]',
          message: 'Write to the outbox through withEvents() from src/outbox only (ADR 0003).',
        },
      ],
    },
  },
];
