import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BUILD_MARKER_FILE, originSpecMode, vacuousReason } from '../e2e/support/build-origin';

/**
 * The guard on `e2e/runtime-origin.spec.ts` (#302). That spec can only fail against a build made
 * with a different origin than the server runs with; against any other build it is three green
 * ticks that prove nothing. These are the cases in which it must say so instead.
 */

const ORIGIN = 'https://build-time.invalid';
const dirs: string[] = [];

function buildDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'storefront-e2e-build-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('vacuousReason', () => {
  it('trusts a build whose marker names this build id and the expected origin', () => {
    const dir = buildDir({
      BUILD_ID: 'abc123\n',
      [BUILD_MARKER_FILE]: JSON.stringify({ buildId: 'abc123', siteUrl: ORIGIN }),
    });
    expect(vacuousReason(dir, ORIGIN)).toBeNull();
  });

  it('does not trust an ordinary build: no marker', () => {
    const dir = buildDir({ BUILD_ID: 'abc123' });
    expect(vacuousReason(dir, ORIGIN)).toMatch(/not made by scripts\/e2e-server\.mjs/);
  });

  it('does not let a stale marker vouch for a later, ordinary build', () => {
    const dir = buildDir({
      BUILD_ID: 'newer-build',
      [BUILD_MARKER_FILE]: JSON.stringify({ buildId: 'abc123', siteUrl: ORIGIN }),
    });
    expect(vacuousReason(dir, ORIGIN)).toMatch(/rebuilt the ordinary way/);
  });

  it('does not trust a marker for another origin', () => {
    const dir = buildDir({
      BUILD_ID: 'abc123',
      [BUILD_MARKER_FILE]: JSON.stringify({ buildId: 'abc123', siteUrl: 'http://localhost:3100' }),
    });
    expect(vacuousReason(dir, ORIGIN)).toMatch(/SITE_URL=http:\/\/localhost:3100/);
  });

  it('does not trust a missing build or an unreadable marker', () => {
    expect(vacuousReason(buildDir({}), ORIGIN)).toMatch(/no build found/);
    const dir = buildDir({ BUILD_ID: 'abc123', [BUILD_MARKER_FILE]: '{not json' });
    expect(vacuousReason(dir, ORIGIN)).toMatch(/unreadable/);
  });
});

describe('originSpecMode', () => {
  it('runs when the build can be trusted, on a laptop and on CI', () => {
    expect(originSpecMode(null, false)).toEqual({ run: true });
    expect(originSpecMode(null, true)).toEqual({ run: true });
  });

  it('skips locally, with the reason in the message', () => {
    const mode = originSpecMode('the build was not made by scripts/e2e-server.mjs', false);
    expect(mode).toMatchObject({ run: false, fail: false });
    expect(mode.run === false && mode.message).toMatch(/would pass vacuously: the build was not/);
  });

  it('fails on CI, where a reused or foreign build can only be a broken setup', () => {
    expect(originSpecMode('no build found', true)).toMatchObject({ run: false, fail: true });
  });
});
