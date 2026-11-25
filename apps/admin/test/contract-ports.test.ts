/**
 * Each contract suite in test-contract/ boots its own Prism, on its own port. Vitest runs the files in
 * parallel workers, so two suites on one port fail with EADDRINUSE (bi and settings both took :4217).
 * This keeps the ports distinct, and clear of `pnpm mock` (:4011) and the Prism the accounting e2e
 * starts (:4013).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(process.cwd(), 'test-contract');

function suites(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return suites(path);
    return /\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** The port each suite starts Prism on (`startPrism(BASE)` with a literal `127.0.0.1:<port>` BASE). */
const ports = suites(ROOT).flatMap((file) => {
  const source = readFileSync(file, 'utf8');
  if (!source.includes('startPrism(')) return [];
  const port = /const BASE = 'http:\/\/127\.0\.0\.1:(\d+)'/.exec(source)?.[1];
  return [{ file: relative(ROOT, file).replace(/\\/g, '/'), port }];
});

describe('contract suites run together', () => {
  it('every suite that starts Prism names a literal port', () => {
    expect(ports.length).toBeGreaterThan(0);
    for (const { file, port } of ports) expect(port, file).toMatch(/^\d+$/);
  });

  it('no two suites share a port, and none takes :4011 (pnpm mock) or :4013 (accounting e2e)', () => {
    const byPort = new Map<string, string[]>();
    for (const { file, port } of ports) {
      byPort.set(port!, [...(byPort.get(port!) ?? []), file]);
    }
    const shared = [...byPort].filter(([, files]) => files.length > 1);
    expect(shared, JSON.stringify(shared)).toEqual([]);
    expect(byPort.has('4011')).toBe(false);
    expect(byPort.has('4013')).toBe(false);
  });
});
