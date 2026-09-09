import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Boots the Admin API spec under Prism for a contract suite.
 *
 * Each suite gets its own instance on its own port rather than sharing one: vitest runs files in
 * separate workers, so a shared server would need coordination the tests do not otherwise need, and
 * a port clash with `pnpm mock` on :4011 would be a confusing failure.
 */
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const prismCli = resolve(
  dirname(require.resolve('@stoplight/prism-cli/package.json')),
  'dist/index.js',
);
const spec = resolve(here, '../../../packages/contracts/openapi/admin-api.yaml');

export interface PrismHandle {
  base: string;
  stop: () => void;
}

export function startPrism(base: string): Promise<PrismHandle> {
  const url = new URL(base);
  return new Promise<PrismHandle>((ready, fail) => {
    const child: ChildProcess = spawn(
      process.execPath,
      [prismCli, 'mock', spec, '--port', url.port, '--host', url.hostname, '--errors'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let log = '';
    const onData = (chunk: Buffer) => {
      log += chunk.toString();
      if (/Prism is listening/.test(log)) {
        ready({ base, stop: () => child.kill() });
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('exit', (code) => fail(new Error(`prism exited ${code}: ${log}`)));
    setTimeout(() => fail(new Error(`prism did not start: ${log}`)), 40_000);
  });
}

/** Prism returns a documented response by status when asked with `Prefer: code=<n>`. */
export const preferring = (code: number): Record<string, string> => ({ Prefer: `code=${code}` });

/** From `packages/db` SEED_IDS. */
export const SEED_STORE_ID = '00000000-0000-4000-8000-000000000031';
