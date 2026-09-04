// Structural guards (also enforced by eslint.config.mjs for the pg rule): nothing but src/lib/db.ts touches pg,
// and nothing but src/outbox writes to the outbox table (ADR 0003, task 1.5).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

const files = walk(SRC).map((p) => ({
  rel: relative(SRC, p).replace(/\\/g, '/'),
  text: readFileSync(p, 'utf8'),
}));

describe('structural guards', () => {
  it('only src/lib/db.ts imports pg', () => {
    const offenders = files
      .filter((f) => f.rel !== 'lib/db.ts')
      .filter((f) => /from\s+['"]pg(\/|['"])|require\(\s*['"]pg['"]\s*\)/.test(f.text))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('only src/outbox writes to the outbox table', () => {
    const offenders = files
      .filter((f) => !f.rel.startsWith('outbox/'))
      .filter((f) => /insert\s+into\s+"?outbox"?/i.test(f.text))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('modules import the outbox helper through its index only', () => {
    const offenders = files
      .filter((f) => !f.rel.startsWith('outbox/'))
      .filter((f) => /from\s+['"][./]*outbox\/with-events['"]/.test(f.text))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});
