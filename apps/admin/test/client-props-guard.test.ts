import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
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
 * `marketing/**` is window 17's tree (docs/ownership.md) and is not policed here.
 */
const APP = join(__dirname, '..', 'src', 'app');
const ROOTS = [join(APP, '(store)'), join(APP, '(hq)')];
const PII_RECORDS = ['Customer', 'Order', 'OrderSummary', 'StaffUser', 'Address'];
const PATTERN = new RegExp(`AdminComponents\\['(${PII_RECORDS.join('|')})'\\]`);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === 'marketing' ? [] : walk(path);
    }
    return /\.(tsx|ts)$/.test(name) ? [path] : [];
  });
}

const clientFiles = ROOTS.flatMap(walk).filter((path) => {
  const head = readFileSync(path, 'utf8').slice(0, 200);
  return /^['"]use client['"]/.test(head);
});

describe("no 'use client' component names a PII-bearing contract record", () => {
  it('finds the client components it is meant to police', () => {
    expect(clientFiles.length).toBeGreaterThan(5);
  });

  it.each(clientFiles.map((path) => [relative(APP, path), path]))('%s', (_label, path) => {
    const source = readFileSync(path, 'utf8');
    const hit = source.match(PATTERN);
    expect(
      hit,
      `${relative(APP, path)} names AdminComponents['${hit?.[1] ?? ''}'] — take a ClientSafe projection instead (src/lib/client-safe.ts)`,
    ).toBeNull();
  });
});
