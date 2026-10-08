// Test helpers (exported as @platform/auth-sdk/testing). Dev/CI realms only: the `test-cli` password grant
// (password = username for the seeded staff users) and the one copy in code of owner's dev TOTP secret (#43).
//
// Issue #346: `owner` is the only seeded staff user enrolled with TOTP, and Keycloak refuses a one-time code
// that was already used. Three live suites sign owner in (the core's auth-live.test.ts, hq-rbac's
// scope.test.ts, keycloak-realms.test.ts's browser challenge), in CI seconds apart, so two of them could need
// the same 30-second code. This module signs owner in ONCE per 15 minutes and shares the token across
// processes through a per-user file (RUNNER_TEMP in CI); every other suite reuses it and spends no code. The
// browser-challenge test must still spend one (the challenge is what it tests), so the grant keeps its step
// fallback as the safety net: previous step → current step → wait for the next fresh step.
import { createHmac } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Dev-only TOTP secret of the pre-enrolled `owner` user (infra/keycloak/README.md, issue #43). */
export const OWNER_DEV_TOTP_SECRET = 'owner-dev-totp-secret-20260905';

/** The staff realm's OTP policy period (`otpPolicyPeriod`), in milliseconds. */
export const TOTP_STEP_MS = 30_000;

/**
 * Pause after a refused owner grant before the next attempt (#406). The staff realm's brute-force protection
 * treats two refused logins within `quickLoginCheckMilliSeconds` (1000) as a quick login and blocks the user
 * for `minimumQuickLoginWaitSeconds` (60) — every code would then be refused, the fresh step's included.
 */
export const RETRY_GAP_MS = 1_500;

/** RFC 6238 TOTP over the raw secret string (HmacSHA1, 6 digits, 30 s) — the staff realm's OTP policy. */
export function totp(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / TOTP_STEP_MS)));
  const h = createHmac('sha1', Buffer.from(secret, 'utf8')).update(counter).digest();
  const o = h[h.length - 1]! & 0xf;
  return ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

/** Milliseconds until half a second into the next TOTP step: its code cannot have been used by anyone yet. */
export function msUntilNextTotpStep(now = Date.now()): number {
  return TOTP_STEP_MS + 500 - (now % TOTP_STEP_MS);
}

/** Sleeps into the next TOTP step (see `msUntilNextTotpStep`). */
export async function waitForNextTotpStep(now = Date.now()): Promise<void> {
  await new Promise((r) => setTimeout(r, msUntilNextTotpStep(now)));
}

/**
 * Where owner's token is shared between processes: `STAFF_OWNER_TOKEN_FILE`, else `RUNNER_TEMP` (CI: the runner
 * discards it with the job), else the per-user `~/.cache/platform` (never a world-shared temp directory).
 */
export function ownerTokenFile(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.STAFF_OWNER_TOKEN_FILE ??
    join(env.RUNNER_TEMP ?? join(homedir(), '.cache', 'platform'), 'staff-owner-token.json')
  );
}

/** Content of the shared file. Nothing else is stored: no refresh token, no secret, no timestamp. */
export interface OwnerTokenFile {
  /** `${KEYCLOAK_URL}/realms/staff` of the process that wrote it — another stack's token is never reused. */
  issuer: string;
  access_token: string;
}

export interface StaffTokenOptions {
  /** Keycloak base URL; default `KEYCLOAK_URL` or `http://localhost:8180`. */
  keycloakUrl?: string;
  /** Realm; default `staff`. The owner cache applies to the staff realm only. */
  realm?: string;
  /** Password; default = username (the seeded staff users). */
  password?: string;
  /** Shared owner-token file; default `ownerTokenFile()`. */
  file?: string;
  /**
   * A cached token with less than this left on its `exp` is not reused (default 5 min): a whole run must fit
   * before it expires, and a cold grant costs only one code (#422 follow-up: a stale file from another window).
   */
  minRemainingMs?: number;
  /** Tests of this helper only: a fake clock so the "next fresh step" fallback does not really sleep. */
  clock?: { now(): number; sleep(ms: number): Promise<void> };
}

interface TokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

const memo = new Map<string, string>();
/** The shared file this process wrote, if any (deleted by `forgetStaffToken` outside CI). */
let written: string | null = null;

/** Forgets the in-process memo (tests of this helper). The shared file is left alone. */
export function clearStaffTokenMemo(): void {
  memo.clear();
}

/**
 * For `afterAll` of every suite that calls `staffToken('owner')`: forgets the memo and deletes the shared file
 * when this process created it — locally only. In CI (`CI` or `RUNNER_TEMP` set) it must outlive the step that wrote it,
 * that is the one-sign-in-per-job; the runner discards `RUNNER_TEMP` with the job.
 */
export async function forgetStaffToken(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  memo.clear();
  if (written && !env.CI && !env.RUNNER_TEMP) await unlink(written).catch(() => undefined);
  written = null;
}

/**
 * A real access token of a seeded user through the dev-only `test-cli` password grant.
 *
 * Memoized per issuer + user for the process. For `owner` (the one user with TOTP) the token is first looked
 * up in the shared file and reused when its issuer is this stack's and Keycloak's userinfo endpoint still
 * accepts it; a fresh grant is written back for the next process. Never logs or returns anything but the
 * access token.
 */
export async function staffToken(username: string, opts: StaffTokenOptions = {}): Promise<string> {
  const kc = opts.keycloakUrl ?? process.env.KEYCLOAK_URL ?? 'http://localhost:8180';
  const realm = opts.realm ?? 'staff';
  const issuer = `${kc}/realms/${realm}`;
  const key = `${issuer}#${username}`;
  const cached = memo.get(key);
  if (cached) return cached;

  const isOwner = realm === 'staff' && username === 'owner';
  const file = opts.file ?? ownerTokenFile();
  if (isOwner) {
    const shared = await readSharedOwnerToken(
      file,
      issuer,
      opts.minRemainingMs ?? 5 * 60_000,
      opts.clock ? opts.clock.now() : Date.now(),
    );
    if (shared) {
      memo.set(key, shared);
      return shared;
    }
  }

  const token = await grant(issuer, username, opts.password ?? username, isOwner, opts.clock);
  if (isOwner && (await writeSharedOwnerToken(file, { issuer, access_token: token })))
    written = file;
  memo.set(key, token);
  return token;
}

/** The customers realm counterpart (no TOTP, no sharing): `test-cli` password grant for a seeded customer. */
export function customerToken(
  username: string,
  password: string,
  opts: Pick<StaffTokenOptions, 'keycloakUrl'> = {},
): Promise<string> {
  return staffToken(username, { ...opts, realm: 'customers', password });
}

async function grant(
  issuer: string,
  username: string,
  password: string,
  withOtp: boolean,
  clock: StaffTokenOptions['clock'],
): Promise<string> {
  const now = () => (clock ? clock.now() : Date.now());
  const sleep = (ms: number) =>
    clock ? clock.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms));
  const post = async (otpAt?: number): Promise<TokenResponse> => {
    const body = new URLSearchParams({
      client_id: 'test-cli',
      grant_type: 'password',
      username,
      password,
      // Without `openid` the token has no OIDC scope and userinfo answers 403 (measured, Keycloak 26) — the
      // liveness check below needs it.
      scope: 'openid',
    });
    // Keycloak's built-in direct-grant flow validates OTP conditionally: only the enrolled user needs a code.
    if (withOtp) body.set('otp', totp(OWNER_DEV_TOTP_SECRET, otpAt));
    const res = await fetch(`${issuer}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    try {
      return (await res.json()) as TokenResponse;
    } catch {
      return { error: `http ${res.status}` };
    }
  };
  if (!withOtp) {
    const json = await post();
    if (!json.access_token)
      throw new Error(`token for ${username}: ${json.error ?? 'no access_token'}`);
    return json.access_token;
  }
  // The look-ahead of 1 accepts the previous step's code; using it first leaves the current step's code to a
  // browser challenge running at the same moment. Refused (already used) → the current step → a fresh step
  // nobody can have spent yet. Never two attempts within a second: a refusal costs RETRY_GAP_MS first.
  let json = await post(now() - TOTP_STEP_MS);
  if (!json.access_token) {
    await sleep(RETRY_GAP_MS);
    json = await post(now());
  }
  if (!json.access_token) {
    await sleep(Math.max(msUntilNextTotpStep(now()), RETRY_GAP_MS));
    json = await post(now());
  }
  if (!json.access_token)
    throw new Error(`token for ${username}: ${json.error ?? 'no access_token'}`);
  return json.access_token;
}

/** The shared token, or null when the file is missing, malformed, another stack's, expiring or no longer accepted. */
async function readSharedOwnerToken(
  file: string,
  issuer: string,
  minRemainingMs: number,
  now: number,
): Promise<string | null> {
  let parsed: Partial<OwnerTokenFile>;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<OwnerTokenFile>;
  } catch {
    return null;
  }
  if (parsed.issuer !== issuer || typeof parsed.access_token !== 'string') return null;
  const exp = jwtExp(parsed.access_token);
  if (exp === null || exp * 1000 - now < minRemainingMs) return null;
  // One GET, spends no code: catches a Keycloak restart, a realm reimport or `pnpm dev --reset` on the shared
  // stack, where `exp` alone would hand the suite a token its verifier rejects.
  try {
    const res = await fetch(`${issuer}/protocol/openid-connect/userinfo`, {
      headers: { authorization: `Bearer ${parsed.access_token}` },
      signal: AbortSignal.timeout(5_000),
    });
    return res.status === 200 ? parsed.access_token : null;
  } catch {
    return null;
  }
}

/** Atomic and private: mode 0600, written next to the target, then renamed over it, so a reader never sees a partial file. */
async function writeSharedOwnerToken(file: string, content: OwnerTokenFile): Promise<boolean> {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(tmp, JSON.stringify(content), { mode: 0o600 });
    await rename(tmp, file);
    return true;
  } catch {
    // Sharing is best effort: an unwritable directory only costs the next process one grant.
    await unlink(tmp).catch(() => undefined);
    return false;
  }
}

/** `exp` (seconds) of an unverified JWT payload, or null when it has none. */
function jwtExp(token: string): number | null {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}
