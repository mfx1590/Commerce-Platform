/** @vitest-environment node */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * src/instrumentation-client.ts presets zod's global config instead of importing `config` (bundle
 * size). This pins the two facts that makes safe: zod adopts the preset, and with it an object
 * schema never calls `Function` — the eval probe the admin's CSP reports as a violation.
 */
describe('zod jitless, preset by the client instrumentation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as { __zod_globalConfig?: unknown }).__zod_globalConfig;
    vi.resetModules();
  });

  it('is adopted by zod, and an object schema then never touches Function', async () => {
    delete (globalThis as { __zod_globalConfig?: unknown }).__zod_globalConfig;
    vi.resetModules();
    await import('@/instrumentation-client');
    const realFunction = globalThis.Function;
    const calls: unknown[][] = [];
    vi.stubGlobal(
      'Function',
      new Proxy(realFunction, {
        apply: (target, self, args: unknown[]) => {
          calls.push(args);
          return Reflect.apply(target, self, args);
        },
        construct: (target, args: unknown[]) => {
          calls.push(args);
          return Reflect.construct(target, args);
        },
      }),
    );

    const { config } = await import('zod/v4/core');
    const { z } = await import('zod');
    const schema = z.object({ title: z.string(), price: z.number() });

    expect(config().jitless).toBe(true);
    expect(schema.parse({ title: 'Tee', price: 1200 })).toEqual({ title: 'Tee', price: 1200 });
    expect(calls).toEqual([]);
  });

  it('without the preset zod does probe Function — so the test above can fail', () => {
    // A fresh Node process: zod is loaded natively and cached for the whole worker, so an
    // in-process "before" would only see the config the first test left behind.
    const script = [
      'let calls = 0;',
      'const F = globalThis.Function;',
      'globalThis.Function = new Proxy(F, { apply: (t, s, a) => (calls++, Reflect.apply(t, s, a)), construct: (t, a) => (calls++, Reflect.construct(t, a)) });',
      "const { z } = await import('zod');",
      "z.object({ title: z.string() }).parse({ title: 'Tee' });",
      'console.log(calls);',
    ].join('\n');
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
    });

    expect(Number(out.trim())).toBeGreaterThan(0);
  });
});
