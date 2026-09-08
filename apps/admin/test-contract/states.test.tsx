/**
 * The state pattern against the real mock, not a stubbed fetch.
 *
 * The unit tests prove each panel renders; this proves the whole chain — a genuine `403` from Prism
 * travels through `adminRequest`'s discriminated result and comes out as the panel that names the
 * missing relation. If the contract's documented error example ever stopped matching what the code
 * reads (`details.relation` / `details.object`), the unit tests would still pass and this would not.
 *
 * Prism is spawned here rather than assumed, so `pnpm --filter @platform/admin test:contract` needs
 * nothing running. It boots on its own port to stay clear of `pnpm mock` on :4011.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiStatePanel } from '@/components/states/state-panel';
import { adminRequest } from '@/lib/api/admin-client';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const prism = resolve(
  dirname(require.resolve('@stoplight/prism-cli/package.json')),
  'dist/index.js',
);
const spec = resolve(here, '../../../packages/contracts/openapi/admin-api.yaml');

/**
 * `vitest.contract.config.ts` forces `ADMIN_API_URL` to the URL this suite spawns Prism on, so a
 * developer's `.env` pointing the app at the real core cannot drag these assertions off the spec.
 * The fallback keeps the file runnable on its own.
 */
const BASE = process.env.ADMIN_API_URL ?? 'http://127.0.0.1:4211';
const PORT = Number(new URL(BASE).port);
const STORE_ID = '00000000-0000-4000-8000-000000000031';

let child: ChildProcess | undefined;

beforeAll(
  () =>
    new Promise<void>((ready, fail) => {
      child = spawn(
        process.execPath,
        [prism, 'mock', spec, '--port', String(PORT), '--host', new URL(BASE).hostname, '--errors'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let log = '';
      const onData = (chunk: Buffer) => {
        log += chunk.toString();
        if (/Prism is listening/.test(log)) ready();
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('exit', (code) => fail(new Error(`prism exited ${code}: ${log}`)));
      setTimeout(() => fail(new Error(`prism did not start: ${log}`)), 40_000);
    }),
  60_000,
);

afterAll(() => {
  child?.kill();
});

/** Prism returns a documented response by status when asked with `Prefer: code=<n>`. */
const preferring = (code: number) => ({ Prefer: `code=${code}` });

describe('a real 403 from the mock becomes the panel that names the relation', () => {
  it('adminRequest reports it as a failure rather than throwing', async () => {
    const result = await adminRequest<'listLegalEntities'>({
      baseUrl: BASE,
      path: '/admin/legal-entities',
      accessToken: 'test',
      headers: preferring(403),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.status).toBe(403);
    expect(result.error.code).toEqual('forbidden');
    // The contract's own example carries the relation and object the panel reads.
    expect(result.error.details).toMatchObject({ relation: 'finance', object: 'organization:hq' });
  });

  it('renders as "you need <relation> on <object>"', async () => {
    const result = await adminRequest<'listLegalEntities'>({
      baseUrl: BASE,
      path: '/admin/legal-entities',
      accessToken: 'test',
      headers: preferring(403),
    });
    if (result.ok) throw new Error('expected a refusal');

    render(<ApiStatePanel status={result.status} error={result.error} />);
    expect(
      screen.getByText(/You need the finance relation on organization:hq/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Ask an organization owner/)).toBeInTheDocument();
  });

  it('does the same for a store-scoped operation', async () => {
    const result = await adminRequest<'listProducts'>({
      baseUrl: BASE,
      path: `/admin/stores/${STORE_ID}/products`,
      accessToken: 'test',
      headers: preferring(403),
    });
    if (result.ok) throw new Error('expected a refusal');

    render(<ApiStatePanel status={403} error={result.error} />);
    expect(screen.getByRole('heading', { name: /do not have access/i })).toBeInTheDocument();
  });
});

describe('the other documented errors travel the same way', () => {
  it('401 becomes the sign-in-again panel', async () => {
    const result = await adminRequest<'getMe'>({
      baseUrl: BASE,
      path: '/admin/me',
      accessToken: 'test',
      headers: preferring(401),
    });
    if (result.ok) throw new Error('expected a refusal');

    expect(result.status).toBe(401);
    render(<ApiStatePanel status={result.status} error={result.error} />);
    expect(screen.getByRole('link', { name: /Sign in again/ })).toBeInTheDocument();
  });

  it('404 becomes the not-found panel, scoped to the store', async () => {
    const result = await adminRequest<'getProduct'>({
      baseUrl: BASE,
      path: `/admin/stores/${STORE_ID}/products/${STORE_ID}`,
      accessToken: 'test',
      headers: preferring(404),
    });
    if (result.ok) throw new Error('expected a refusal');

    expect(result.status).toBe(404);
    render(
      <ApiStatePanel
        status={result.status}
        error={result.error}
        what="This product"
        storeId={STORE_ID}
      />,
    );
    expect(screen.getByRole('heading', { name: 'This product was not found' })).toBeInTheDocument();
    expect(screen.getByText(/Searched in store/)).toBeInTheDocument();
  });

  it('a 200 is still a success — the pattern does not swallow good responses', async () => {
    const result = await adminRequest<'getMe'>({
      baseUrl: BASE,
      path: '/admin/me',
      accessToken: 'test',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.data.organization.slug).toEqual('hq');
  });
});
