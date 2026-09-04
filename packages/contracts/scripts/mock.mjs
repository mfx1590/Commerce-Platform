#!/usr/bin/env node
// `pnpm mock`: Prism mock servers for both specs. Store API on :4010, Admin API on :4011 (override with env).
// Feature windows point their apps at these URLs in Phase 1 (MOCK_API_URL / MOCK_ADMIN_API_URL in .env.example).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const prism = resolve(dirname(require.resolve('@stoplight/prism-cli/package.json')), 'dist/index.js');

const servers = [
  { name: 'store', spec: resolve(here, '../openapi/store-api.yaml'), port: process.env.MOCK_STORE_PORT ?? '4010' },
  { name: 'admin', spec: resolve(here, '../openapi/admin-api.yaml'), port: process.env.MOCK_ADMIN_PORT ?? '4011' },
];

const children = servers.map(({ name, spec, port }) => {
  const child = spawn(
    process.execPath,
    [prism, 'mock', spec, '--host', '0.0.0.0', '--port', port, '--errors', '--cors'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const tag = `[mock:${name}:${port}]`;
  child.stdout.on('data', (d) => process.stdout.write(`${tag} ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`${tag} ${d}`));
  child.on('exit', (code) => {
    console.error(`${tag} exited with ${code}`);
    shutdown(code ?? 1);
  });
  return child;
});

function shutdown(code = 0) {
  for (const c of children) if (!c.killed) c.kill();
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
console.info('mock: Store API http://localhost:%s  Admin API http://localhost:%s', servers[0].port, servers[1].port);
