// apps/core ESLint config: the root rules plus this app's own guards. Since ESLint 10 the config is resolved from
// each linted file's directory, so the root `pnpm lint` applies this file to apps/core too, as does
// `pnpm --filter @platform/core lint`. It must keep spreading `root`: for files under apps/core this config
// REPLACES the root one, it does not add to it.
import root from '../../eslint.config.mjs';

export default [
  ...root,
  // `medusa build` output (gitignored) must never be linted.
  { ignores: ['.medusa/**'] },
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
          patterns: [
            { group: ['pg/*'] },
            // ADR 0005 module boundary: another module's internals are never imported directly — only its
            // index.ts (`../modules/catalog`, `../../modules/registry`). Same-module relative imports do not
            // contain the `modules/` segment and stay allowed; test/guards.test.ts resolves those too.
            {
              group: ['**/modules/*/*', '!**/modules/*/index', '!**/modules/*/index.js'],
              message:
                'Import a module through its index.ts (ADR 0005): `../modules/<name>`, never `../modules/<name>/<file>`.',
            },
          ],
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
