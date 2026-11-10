import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * #762: `experimental.inlineCss` is the starter's LCP fix (the render-blocking stylesheet held the
 * h1 back under Lighthouse mobile throttling). It is an EXPERIMENTAL Next flag, so a `next` bump
 * can rename or drop it without a type error: this pins that the config still sets it, and the
 * perf leg catches the LCP regression if Next stops honouring it.
 *
 * The real `next.config.mjs` is loaded in a child process, as `next build` loads it: it imports
 * Next's plugin and `@platform/cms`, which Vitest's module graph has no business pulling in.
 */
function loadConfig(): { experimental?: Record<string, unknown> } {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "const { default: c } = await import('./next.config.mjs'); process.stdout.write(JSON.stringify({ experimental: c.experimental ?? null }));",
    ],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as { experimental?: Record<string, unknown> };
}

describe('next.config.mjs', () => {
  it('inlines the CSS (#762): no render-blocking stylesheet ahead of the h1', () => {
    expect(loadConfig().experimental).toMatchObject({ inlineCss: true });
  }, 30_000);
});
