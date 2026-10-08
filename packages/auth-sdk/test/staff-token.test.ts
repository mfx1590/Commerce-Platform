// @platform/auth-sdk/testing — the shared owner-token fixture (#346).
// Unit part: a fake Keycloak (node:http) that refuses used one-time codes, so every branch of the protocol is
// exercised without a stack. Live part: the real staff realm (skips when docker Keycloak is down).
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearStaffTokenMemo,
  customerToken,
  forgetStaffToken,
  msUntilNextTotpStep,
  OWNER_DEV_TOTP_SECRET,
  ownerTokenFile,
  RETRY_GAP_MS,
  staffToken,
  TOTP_STEP_MS,
  totp,
} from '../src/testing.js';

const KC = process.env.KEYCLOAK_URL ?? 'http://localhost:8180';

/** A clock the helper and the fake Keycloak share; `sleep` advances it instead of waiting. */
function fakeClock(start = 1_760_000_000_000) {
  let t = start;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    slept,
    set: (ms: number) => {
      t = ms;
    },
  };
}

/**
 * Fake Keycloak: test-cli password grant with conditional OTP for owner, single-use codes, userinfo, and the
 * realm's brute-force quick-login rule (two refused logins within 1 s block the user for 60 s, #406).
 */
function fakeKeycloak(clock: { now(): number }) {
  const QUICK_LOGIN_CHECK_MS = 1_000;
  const QUICK_LOGIN_WAIT_MS = 60_000;
  /** token → granted scope: userinfo answers 403 without `openid`, as Keycloak does. */
  const issued = new Map<string, string>();
  const usedCodes = new Set<string>();
  const state = {
    grants: 0,
    userinfo: 0,
    /** Refused logins counted by the brute-force detector (a refusal during a block is not counted). */
    failures: 0,
    lastFailure: -Infinity,
    /** Quick-login block in force until this time (0 = none). */
    blockedUntil: 0,
    lastBody: new URLSearchParams(),
    /** Forgets every token it issued: what a restart, a reimport or `pnpm dev --reset` does. */
    restart: () => issued.clear(),
    /** A fresh realm for the next test: no token issued, no code spent. */
    reset: () => {
      issued.clear();
      usedCodes.clear();
      state.failures = 0;
      state.lastFailure = -Infinity;
      state.blockedUntil = 0;
    },
    /** A code somebody else spent in this or an adjacent step. */
    spend: (code: string) => usedCodes.add(code),
  };
  const mint = (scope: string) => {
    const payload = Buffer.from(
      JSON.stringify({ sub: 'seed-owner', exp: Math.floor(clock.now() / 1000) + 900 }),
    ).toString('base64url');
    const token = `eyJhbGciOiJSUzI1NiJ9.${payload}.sig${issued.size}-${Math.random().toString(36).slice(2)}`;
    issued.set(token, scope);
    return token;
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const m = req.url?.match(
        /^\/realms\/(staff|customers)\/protocol\/openid-connect\/(token|userinfo)$/,
      );
      if (!m) return json(404, { error: 'not_found' });
      if (m[2] === 'userinfo') {
        state.userinfo++;
        const bearer = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
        if (!issued.has(bearer)) return json(401, { error: 'invalid_token' });
        if (!issued.get(bearer)!.split(' ').includes('openid'))
          return json(403, { error: 'insufficient_scope' });
        return json(200, { sub: 'seed-owner' });
      }
      state.grants++;
      const body = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      state.lastBody = body;
      if (body.get('client_id') !== 'test-cli' || body.get('grant_type') !== 'password') {
        return json(400, { error: 'invalid_client' });
      }
      const username = body.get('username') ?? '';
      const password = body.get('password') ?? '';
      const ok =
        m[1] === 'customers'
          ? username === 'jane@example.com' && password === 'jane'
          : password === username;
      const refuse = () => {
        const now = clock.now();
        if (now < state.blockedUntil) return json(401, { error: 'invalid_grant' });
        if (now - state.lastFailure < QUICK_LOGIN_CHECK_MS)
          state.blockedUntil = now + QUICK_LOGIN_WAIT_MS;
        state.lastFailure = now;
        state.failures++;
        return json(401, { error: 'invalid_grant' });
      };
      if (clock.now() < state.blockedUntil) return refuse();
      if (!ok) return refuse();
      if (m[1] === 'staff' && username === 'owner') {
        // Keycloak's direct-grant flow: the enrolled user must send a code of the previous, current or next
        // step (look-ahead 1), and a code that was already used is refused (otpPolicyCodeReusable: false).
        const otp = body.get('otp') ?? '';
        const now = clock.now();
        const accepted = [now - TOTP_STEP_MS, now, now + TOTP_STEP_MS].map((at) =>
          totp(OWNER_DEV_TOTP_SECRET, at),
        );
        if (!accepted.includes(otp) || usedCodes.has(otp)) return refuse();
        usedCodes.add(otp);
      }
      return json(200, { access_token: mint(body.get('scope') ?? ''), expires_in: 900 });
    });
  });
  return { server, state };
}

describe('staffToken (unit, fake Keycloak)', () => {
  const clock = fakeClock();
  const kc = fakeKeycloak(clock);
  let url = '';
  let dir = '';
  let file = '';
  const issuer = () => `${url}/realms/staff`;
  const opts = () => ({ keycloakUrl: url, file, clock });

  beforeAll(async () => {
    await new Promise<void>((r) => kc.server.listen(0, '127.0.0.1', r));
    const addr = kc.server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    url = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => kc.server.close(() => r()));
  });
  beforeEach(async () => {
    clearStaffTokenMemo();
    dir = await mkdtemp(join(tmpdir(), 'staff-token-test-'));
    file = join(dir, 'owner.json');
    kc.state.reset();
    kc.state.grants = 0;
    kc.state.userinfo = 0;
    clock.slept.length = 0;
  });
  afterEach(async () => {
    await forgetStaffToken({});
    await rm(dir, { recursive: true, force: true });
  });

  it("owner: the first call grants with the PREVIOUS step's code and shares {issuer, access_token}", async () => {
    const token = await staffToken('owner', opts());
    expect(kc.state.grants).toBe(1);
    expect(kc.state.lastBody.get('otp')).toBe(
      totp(OWNER_DEV_TOTP_SECRET, clock.now() - TOTP_STEP_MS),
    );
    expect(kc.state.lastBody.get('scope')).toBe('openid'); // userinfo refuses a token without it
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      issuer: issuer(),
      access_token: token,
    });
    // Atomic write: the temporary file is gone, only the target remains.
    expect(await readdir(dir)).toEqual(['owner.json']);
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('another process reuses the shared token: one userinfo GET, no grant, no code spent', async () => {
    const first = await staffToken('owner', opts());
    clearStaffTokenMemo(); // what a second process starts with
    const second = await staffToken('owner', opts());
    expect(second).toBe(first);
    expect(kc.state.grants).toBe(1);
    expect(kc.state.userinfo).toBe(1);
    // In-process memo: a third call costs nothing at all.
    expect(await staffToken('owner', opts())).toBe(first);
    expect(kc.state.userinfo).toBe(1);
  });

  it("a file from another stack (issuer mismatch) is ignored and replaced by this stack's grant", async () => {
    await writeFile(
      file,
      JSON.stringify({ issuer: 'http://elsewhere:8180/realms/staff', access_token: 'eyJ.e30.x' }),
    );
    const token = await staffToken('owner', opts());
    expect(kc.state.grants).toBe(1);
    expect(kc.state.userinfo).toBe(0);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      issuer: issuer(),
      access_token: token,
    });
  });

  it('Keycloak restarted or realm reimported: userinfo refuses the cached token → a new grant, file rewritten', async () => {
    const first = await staffToken('owner', opts());
    kc.state.restart();
    clearStaffTokenMemo();
    const second = await staffToken('owner', opts());
    expect(second).not.toBe(first);
    expect(kc.state.userinfo).toBe(1);
    // The previous step's code was spent by the first grant: refused, then the current step's code.
    expect(kc.state.grants).toBe(3);
    expect(kc.state.lastBody.get('otp')).toBe(totp(OWNER_DEV_TOTP_SECRET, clock.now()));
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ access_token: second });
  });

  it('a cached token with less than 5 min left is not reused (a run must fit before it expires)', async () => {
    const payload = Buffer.from(
      JSON.stringify({ sub: 'seed-owner', exp: Math.floor(clock.now() / 1000) + 4 * 60 }),
    ).toString('base64url');
    await writeFile(file, JSON.stringify({ issuer: issuer(), access_token: `eyJ.${payload}.sig` }));
    await staffToken('owner', opts());
    expect(kc.state.userinfo).toBe(0);
    expect(kc.state.grants).toBe(1);
  });

  it('a malformed file is ignored', async () => {
    await writeFile(file, 'not json');
    await staffToken('owner', opts());
    expect(kc.state.grants).toBe(1);
  });

  it("previous step's code already spent → the current step's; both spent → the next fresh step", async () => {
    const t0 = clock.now();
    kc.state.spend(totp(OWNER_DEV_TOTP_SECRET, t0 - TOTP_STEP_MS));
    await staffToken('owner', opts());
    expect(kc.state.grants).toBe(2);
    expect(kc.state.lastBody.get('otp')).toBe(totp(OWNER_DEV_TOTP_SECRET, t0));
    expect(clock.slept).toEqual([RETRY_GAP_MS]); // never two attempts within a second (#406)
    expect(kc.state.failures).toBe(1);
    expect(kc.state.blockedUntil).toBe(0);

    await forgetStaffToken({});
    kc.state.restart();
    // Now the current step's code is spent too (by the grant above): the helper waits for a fresh step.
    const t1 = clock.now();
    await staffToken('owner', opts());
    expect(kc.state.grants).toBe(5);
    // A gap after the first refusal, then a wait that reaches the next step (at least a gap long) after the
    // second; the block never trips.
    expect(clock.slept.slice(1)).toEqual([
      RETRY_GAP_MS,
      Math.max(msUntilNextTotpStep(t1 + RETRY_GAP_MS), RETRY_GAP_MS),
    ]);
    expect(Math.floor(clock.now() / TOTP_STEP_MS)).toBeGreaterThan(Math.floor(t1 / TOTP_STEP_MS));
    expect(kc.state.lastBody.get('otp')).toBe(totp(OWNER_DEV_TOTP_SECRET, clock.now()));
    expect(kc.state.failures).toBe(3);
    expect(kc.state.blockedUntil).toBe(0);
  });

  it('the fake enforces the quick-login rule: two refusals within a second block even a valid code (#406)', async () => {
    const post = (otp: string) =>
      fetch(`${issuer()}/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'test-cli',
          grant_type: 'password',
          username: 'owner',
          password: 'owner',
          otp,
        }),
      }).then((r) => r.status);
    expect(await post('000000')).toBe(401);
    expect(await post('000000')).toBe(401); // same instant on the fake clock → quick login
    expect(kc.state.blockedUntil).toBe(clock.now() + 60_000);
    expect(await post(totp(OWNER_DEV_TOTP_SECRET, clock.now()))).toBe(401); // valid, still refused
    expect(kc.state.failures).toBe(2);
    // Which is exactly what the helper's gap avoids: with RETRY_GAP_MS between refusals no block forms.
    expect(RETRY_GAP_MS).toBeGreaterThan(1_000);
  });

  it('a user without TOTP: no otp, no file, memoized in-process', async () => {
    const token = await staffToken('finance', opts());
    expect(kc.state.lastBody.has('otp')).toBe(false);
    expect(kc.state.lastBody.get('password')).toBe('finance');
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await staffToken('finance', opts())).toBe(token);
    expect(kc.state.grants).toBe(1);
  });

  it('customerToken: the customers realm with the given password, no file', async () => {
    await customerToken('jane@example.com', 'jane', { keycloakUrl: url });
    expect(kc.state.lastBody.get('password')).toBe('jane');
    expect(kc.state.lastBody.has('otp')).toBe(false);
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a refused grant throws with the realm error, never with the password or a code', async () => {
    await expect(staffToken('finance', { ...opts(), password: 'wrong' })).rejects.toThrow(
      'token for finance: invalid_grant',
    );
  });

  it('forgetStaffToken deletes the file only when this process wrote it, and never in CI', async () => {
    await staffToken('owner', opts());
    await forgetStaffToken({ CI: 'true' });
    await expect(stat(file)).resolves.toBeDefined();

    await staffToken('owner', opts()); // reused from the file: this process did not write it now
    await forgetStaffToken({});
    await expect(stat(file)).resolves.toBeDefined();

    kc.state.restart();
    await staffToken('owner', opts()); // a new grant: written by this process
    await forgetStaffToken({ RUNNER_TEMP: dir });
    await expect(stat(file)).resolves.toBeDefined();

    kc.state.restart();
    await staffToken('owner', opts());
    await forgetStaffToken({});
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('ownerTokenFile: explicit override, else RUNNER_TEMP in CI, else the per-user cache directory', () => {
    expect(ownerTokenFile({ STAFF_OWNER_TOKEN_FILE: '/x/owner.json', RUNNER_TEMP: '/r' })).toBe(
      '/x/owner.json',
    );
    expect(ownerTokenFile({ RUNNER_TEMP: '/r' })).toBe(join('/r', 'staff-owner-token.json'));
    expect(ownerTokenFile({})).toBe(
      join(homedir(), '.cache', 'platform', 'staff-owner-token.json'),
    );
  });

  it('msUntilNextTotpStep lands half a second into the next step', () => {
    for (const at of [0, 1, 29_999, 30_000, 1_760_000_012_345]) {
      const ms = msUntilNextTotpStep(at);
      expect(ms).toBeGreaterThan(500 - 1);
      expect(ms).toBeLessThanOrEqual(TOTP_STEP_MS + 500);
      expect((at + ms) % TOTP_STEP_MS).toBe(500);
    }
  });
});

async function up(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}
const live = await up(`${KC}/realms/staff/.well-known/openid-configuration`);

describe.runIf(live)('staffToken (live Keycloak)', () => {
  // No per-file deletion of the shared file (#406): test/global-setup.ts removes it once at the end of a local
  // run that created it, so the next file reuses this grant instead of spending another code.

  it('owner: a real token (sub seed-owner) that a second process reuses through the shared file', async () => {
    const token = await staffToken('owner');
    const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as {
      sub: string;
      iss: string;
    };
    expect(claims.sub).toBe('seed-owner');
    expect(claims.iss).toBe(`${KC}/realms/staff`);
    const shared = JSON.parse(await readFile(ownerTokenFile(), 'utf8')) as { issuer: string };
    expect(shared).toEqual({ issuer: `${KC}/realms/staff`, access_token: token });
    clearStaffTokenMemo();
    expect(await staffToken('owner')).toBe(token);
  });

  it('a user without TOTP signs in with the password alone', async () => {
    const token = await staffToken('store-admin');
    const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as {
      sub: string;
    };
    expect(claims.sub).toBe('seed-store-admin');
  });
});
