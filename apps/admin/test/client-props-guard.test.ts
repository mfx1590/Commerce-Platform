import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The write-time guard behind `src/lib/client-safe.ts`.
 *
 * A `'use client'` component's props are a wire payload, so no client component in the app may
 * name a PII-bearing contract record: it takes a `ClientSafe<…>` projection instead. This walks
 * every client file under the route groups this window owns and fails on the record names below —
 * which is what would have caught #263 (orders detail panels) and #268 (customers list table)
 * before review.
 *
 * Two evasions the #268 re-review named are closed here: a `'use client'` directive preceded by a
 * comment (the file was not recognised as a client file at all), and a record reached through a
 * type alias exported from another module (`import type { Order } from '@/lib/orders/quantities'`
 * never spells `AdminComponents['Order']`).
 *
 * `marketing/**` is window 17's tree (docs/ownership.md) and is not policed here.
 */
const SRC = join(__dirname, '..', 'src');
const APP = join(SRC, 'app');
const ROOTS = [join(APP, '(store)'), join(APP, '(hq)')];
const PII_RECORDS = ['Customer', 'Order', 'OrderSummary', 'StaffUser', 'Address'];
const PATTERN = new RegExp(`AdminComponents\\['(${PII_RECORDS.join('|')})'\\]`);

function walk(dir: string, skipMarketing: boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return skipMarketing && name === 'marketing' ? [] : walk(path, skipMarketing);
    }
    return /\.(tsx|ts)$/.test(name) ? [path] : [];
  });
}

/** True when the module's first statement is the `'use client'` directive (comments may precede it). */
function isClientModule(source: string): boolean {
  const code = source.replace(/^(?:\s+|\/\/[^\n]*\n?|\/\*[\s\S]*?\*\/)*/, '');
  return /^['"]use client['"]/.test(code);
}

function resolveImport(from: string, specifier: string): string | undefined {
  const base = specifier.startsWith('@/')
    ? join(SRC, specifier.slice(2))
    : specifier.startsWith('.')
      ? resolve(dirname(from), specifier)
      : undefined;
  if (base === undefined) return undefined;
  return [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find((path) => existsSync(path));
}

/** The local names under which `source` imports a PII alias from another module. */
function importedAliases(
  file: string,
  source: string,
  byFile: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(
    /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g,
  )) {
    const target = resolveImport(file, match[2] ?? '');
    const aliases = target === undefined ? undefined : byFile.get(target);
    if (aliases === undefined) continue;
    for (const part of (match[1] ?? '').split(',')) {
      const [imported = '', local] = part
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/);
      if (aliases.has(imported)) names.push(local ?? imported);
    }
  }
  return names;
}

/**
 * Every exported type alias in `src` that stands for a PII record — directly, through an alias in
 * the same file, or through one imported from another module — keyed by file. Iterated to a
 * fixpoint so chains across files are followed.
 */
function piiAliasesByFile(files: readonly string[]): Map<string, Set<string>> {
  const byFile = new Map<string, Set<string>>();
  const sources = new Map(files.map((file) => [file, readFileSync(file, 'utf8')]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [file, source] of sources) {
      const known = byFile.get(file) ?? new Set<string>();
      const local = new Set<string>();
      const aliasDefs = [
        ...source.matchAll(/(?:^|\n)\s*(export\s+)?type\s+(\w+)\s*=\s*([^;\n]+)/g),
      ];
      const reachable = [...importedAliases(file, source, byFile)];
      for (const [, , name = '', rhs = ''] of aliasDefs) {
        // A `ClientSafe<…>` alias is the sanctioned projection, whatever record it picks from.
        if (/^ClientSafe</.test(rhs.trim())) continue;
        const names = [...reachable, ...local];
        if (PATTERN.test(rhs) || names.some((alias) => new RegExp(`\\b${alias}\\b`).test(rhs))) {
          local.add(name);
        }
      }
      for (const [, exported, name = ''] of aliasDefs) {
        if (exported !== undefined && local.has(name) && !known.has(name)) {
          known.add(name);
          changed = true;
        }
      }
      if (known.size > 0) byFile.set(file, known);
    }
  }
  return byFile;
}

const aliases = piiAliasesByFile(walk(SRC, false));

const clientFiles = ROOTS.flatMap((root) => walk(root, true)).filter((path) =>
  isClientModule(readFileSync(path, 'utf8')),
);

describe("no 'use client' component names a PII-bearing contract record", () => {
  it('finds the client components it is meant to police', () => {
    expect(clientFiles.length).toBeGreaterThan(5);
  });

  it('knows the exported aliases that stand for a record (orders/quantities exports Order)', () => {
    expect(aliases.get(join(SRC, 'lib', 'orders', 'quantities.ts'))?.has('Order')).toBe(true);
  });

  it('does not count a ClientSafe projection alias as a record (orders/projection)', () => {
    expect(aliases.get(join(SRC, 'lib', 'orders', 'projection.ts'))?.has('OrderForLines')).not.toBe(
      true,
    );
  });

  it.each(clientFiles.map((path) => [relative(APP, path), path]))('%s', (_label, path) => {
    const source = readFileSync(path, 'utf8');
    const hit = source.match(PATTERN);
    expect(
      hit,
      `${relative(APP, path)} names AdminComponents['${hit?.[1] ?? ''}'] — take a ClientSafe projection instead (src/lib/client-safe.ts)`,
    ).toBeNull();
    const viaAlias = importedAliases(path, source, aliases);
    expect(
      viaAlias,
      `${relative(APP, path)} imports ${viaAlias.join(', ')}, an alias of a PII record — take a ClientSafe projection instead`,
    ).toEqual([]);
  });
});

describe('the guard itself', () => {
  it.each([
    ["'use client';\n", true],
    ['"use client";\n', true],
    ["// The orders panel.\n'use client';\n", true],
    ["/**\n * A panel.\n */\n\n'use client';\n", true],
    ["import x from 'y';\n'use client';\n", false],
    ["export const a = 'use client';\n", false],
  ])('recognises the directive in %j → %s', (source, expected) => {
    expect(isClientModule(source)).toBe(expected);
  });

  it('flags an alias imported from another module, including a renamed one', () => {
    const quantities = join(SRC, 'lib', 'orders', 'quantities.ts');
    const panel = join(APP, '(store)', 'x', 'panel.tsx');
    const map = new Map([[quantities, new Set(['Order'])]]);
    const from = (clause: string): string[] =>
      importedAliases(panel, `import ${clause} from '@/lib/orders/quantities';`, map);
    expect(from('type { Order }')).toEqual(['Order']);
    expect(from('{ type Order as Row, x }')).toEqual(['Row']);
    expect(from('type { Other }')).toEqual([]);
  });
});
