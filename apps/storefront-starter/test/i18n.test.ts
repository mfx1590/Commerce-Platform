import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveCurrency } from '@/lib/i18n';
import type { Store } from '@/lib/store-api';

const MESSAGES_DIR = join(process.cwd(), 'messages');
const catalogues = readdirSync(MESSAGES_DIR).filter((f) => f.endsWith('.json'));

function load(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(MESSAGES_DIR, file), 'utf8')) as Record<string, unknown>;
}

/** Every leaf key, dotted — `plp.sortOptions.newest`. */
function keysOf(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    keysOf(child, prefix === '' ? key : `${prefix}.${key}`),
  );
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)/g)].map((m) => m[1] ?? '').sort();
}

function leaves(value: unknown, prefix = ''): [string, string][] {
  if (typeof value === 'string') return [[prefix, value]];
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leaves(child, prefix === '' ? key : `${prefix}.${key}`),
  );
}

describe('message catalogues', () => {
  it('ships one per configured locale', () => {
    expect(catalogues.sort()).toEqual(['de-DE.json', 'en-GB.json']);
  });

  it('define exactly the same keys, so no locale silently falls back', () => {
    const [first, ...rest] = catalogues;
    const reference = keysOf(load(first!)).sort();
    for (const file of rest) {
      expect({ file, keys: keysOf(load(file)).sort() }).toEqual({ file, keys: reference });
    }
  });

  it('use the same placeholders in every locale', () => {
    const reference = new Map(leaves(load('en-GB.json')));
    for (const [key, text] of leaves(load('de-DE.json'))) {
      expect({ key, placeholders: placeholders(text) }).toEqual({
        key,
        placeholders: placeholders(reference.get(key) ?? ''),
      });
    }
  });

  it('are actually translated, not copied', () => {
    const english = new Map(leaves(load('en-GB.json')));
    const german = leaves(load('de-DE.json'));
    // Some values are legitimately identical across locales (brand words, codes).
    const allowedIdentical = new Set([
      'nav.shop',
      'common.sale',
      'home.code',
      'nav.copyright',
      // "Region (optional)" happens to be identical in both languages.
      'checkout.address.region',
    ]);

    const untranslated = german
      .filter(([key, text]) => english.get(key) === text && !allowedIdentical.has(key))
      .map(([key]) => key);
    expect(untranslated).toEqual([]);
  });
});

describe('resolveCurrency', () => {
  const store = { currencies: ['EUR', 'GBP'], default_currency: 'EUR' } as Store;

  it('honours a currency the store sells in', () => {
    expect(resolveCurrency(store, 'GBP')).toBe('GBP');
  });

  it('falls back to the store default for anything else', () => {
    // A cookie can hold anything; an unsupported currency must never reach POST /store/carts.
    expect(resolveCurrency(store, 'USD')).toBe('EUR');
    expect(resolveCurrency(store, 'not-a-currency')).toBe('EUR');
    expect(resolveCurrency(store, undefined)).toBe('EUR');
  });

  it('keeps working with the API down', () => {
    expect(resolveCurrency(null, 'GBP')).toBe('GBP');
    expect(resolveCurrency(null, undefined)).toBe('EUR');
  });
});

/**
 * Every key the code asks for must exist in the catalogue.
 *
 * next-intl does not fail a render on a missing key — it logs `MISSING_MESSAGE` and prints the key
 * name into the page, so a typo ships as visible rubbish and every end-to-end assertion still
 * passes. That is exactly how `checkout.confirmation.deliveryAddress` slipped through, hence this.
 */
describe('every translation key used in the code exists', () => {
  const reference = new Map(leaves(load('en-GB.json')));

  function sourceFiles(dir: string): string[] {
    let out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out = out.concat(sourceFiles(full));
      else if (entry.endsWith('.tsx') || entry.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  const files = sourceFiles(join(process.cwd(), 'src'));

  it('resolves every t(...) call against en-GB', () => {
    const missing: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      // `const t = useTranslations('plp')` / `const tCommon = await getTranslations('common')`.
      // A name maps to a *set*: one file often holds several components that each bind `t` to a
      // different namespace, and this check is not scope-aware. A key counts as present if it
      // resolves under any namespace that name is bound to in the file — still enough to catch a
      // key that exists nowhere, which is the failure mode that ships broken copy.
      const namespaces = new Map<string, Set<string>>();
      const bind = (name: string, namespace: string) => {
        const set = namespaces.get(name) ?? new Set<string>();
        set.add(namespace);
        namespaces.set(name, set);
      };
      for (const match of source.matchAll(
        /const (\w+)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\(\s*'([^']+)'\s*\)/g,
      )) {
        bind(match[1] ?? '', match[2] ?? '');
      }
      // `getTranslations('cart')` used inline, e.g. inside Promise.all destructuring
      for (const match of source.matchAll(
        /\[([\w,\s]+)\]\s*=\s*await Promise\.all\(\[([\s\S]*?)\]\)/g,
      )) {
        const names = (match[1] ?? '').split(',').map((n) => n.trim());
        const calls = [...(match[2] ?? '').matchAll(/getTranslations\('([^']+)'\)/g)].map(
          (m) => m[1] ?? '',
        );
        // Positional: the nth translator in the array is the nth namespace.
        let index = 0;
        for (const name of names) {
          if (/^t([A-Z]\w*)?$/.test(name) && calls[index] !== undefined) {
            bind(name, calls[index]!);
            index += 1;
          }
        }
      }

      for (const [name, candidates] of namespaces) {
        const calls = source.matchAll(new RegExp(`\\b${name}\\('([^']+)'`, 'g'));
        for (const call of calls) {
          const keys = [...candidates].map((namespace) => `${namespace}.${call[1]}`);
          if (!keys.some((key) => reference.has(key))) {
            missing.push(`${file.split(/[\\/]/).pop()}: ${keys.join(' | ')}`);
          }
        }
      }
    }

    expect(missing).toEqual([]);
  });
});

/**
 * The acceptance criterion for task 1.6: no hard-coded copy in `(shop)` or `(checkout)`.
 *
 * A lint rule would need the root ESLint config, which this window does not own, so the check is a
 * test: it walks the JSX in those route groups and their components and fails on visible text that
 * is not coming from a translation.
 */
describe('no hard-coded strings in (shop) and (checkout)', () => {
  const roots = [
    join(process.cwd(), 'src', 'app', '[locale]', '(shop)'),
    join(process.cwd(), 'src', 'app', '[locale]', '(checkout)'),
    join(process.cwd(), 'src', 'components'),
    join(process.cwd(), 'src', 'layouts'),
  ];

  // Files owned by other windows or outside the two route groups.
  const exempt = new Set(['coming-soon.tsx', 'account-forms.tsx']);

  function walk(dir: string): string[] {
    let out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out = out.concat(walk(full));
      else if (entry.endsWith('.tsx') && !exempt.has(entry)) out.push(full);
    }
    return out;
  }

  const files = roots.flatMap(walk);

  it('finds the files it is supposed to check', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files.map((f) => [f.replace(process.cwd(), '').replace(/\\/g, '/'), f]))(
    '%s renders no literal copy',
    (_name, file) => {
      // Comments legitimately contain prose and angle brackets ("an <a> inside a <button>").
      const source = readFileSync(file, 'utf8')
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      const offenders: string[] = [];

      source.split('\n').forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
        // `page >= 1 && page <= total` is a comparison, not JSX text.
        const isComparison = /(&&|\|\||=>|>=|<=|\?\?)/.test(trimmed);

        // Text between JSX tags: `>Some copy<`. Quoted values are attributes, not rendered copy.
        const between = trimmed.match(/>([^<>{}"']+)</);
        if (between && !isComparison) {
          const text = (between[1] ?? '').trim();
          // Punctuation-only separators (›, /, ×, …) are not copy.
          if (/[A-Za-z]{2,}/.test(text)) offenders.push(`line ${index + 1}: ${text}`);
        }
        // A bare line of prose inside JSX, e.g. a wrapped sentence.
        if (/^[A-Z][A-Za-z ,.'’—-]{12,}$/.test(trimmed)) {
          offenders.push(`line ${index + 1}: ${trimmed}`);
        }
      });

      expect(offenders).toEqual([]);
    },
  );
});
