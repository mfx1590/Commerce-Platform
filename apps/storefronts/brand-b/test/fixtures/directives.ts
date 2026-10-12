/**
 * Fixtures for the `'use client'` directive detection in `i18n.test.ts`.
 *
 * They live in a file of their own because the sources are multi-line string literals, and keeping
 * them inline made the test hard to read (and easy to mangle when edited by script).
 */
export const DIRECTIVE_FIXTURES: { name: string; source: string; isClient: boolean }[] = [
  { name: 'bare directive', source: "'use client';\nimport x from 'y';\n", isClient: true },
  { name: 'double quotes', source: '"use client";\n', isClient: true },
  {
    name: 'line comment first',
    source: "// a note about this component\n\n'use client';\n",
    isClient: true,
  },
  {
    name: 'doc comment first',
    source: "/**\n * A doc comment.\n */\n\n'use client';\n",
    isClient: true,
  },
  { name: 'no directive', source: "import { x } from 'y';\n", isClient: false },
  {
    // Past the top of the module it is an expression statement, not a directive.
    name: 'directive after code',
    source: "import { x } from 'y';\n'use client';\n",
    isClient: false,
  },
];
