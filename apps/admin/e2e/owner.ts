import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';

/**
 * Signing in as the seeded HQ `owner`, who is pre-enrolled for TOTP (staff realm, dev/CI only).
 *
 * The raw TOTP secret is the dev value documented in `infra/keycloak/README.md`; it is read from
 * there at run time rather than repeated in this file, so no secret-shaped string is added to git.
 * Codes are RFC 6238 over the raw string (HmacSHA1, 6 digits, 30 s), as Keycloak's OTP policy and
 * `packages/auth-sdk/test/keycloak-realms.test.ts` compute them.
 */
function devTotpSecret(): string {
  const readme = readFileSync(resolve(process.cwd(), '../../infra/keycloak/README.md'), 'utf8');
  const found = /Dev-only TOTP secret[^`]*`([^`]+)`/.exec(readme);
  if (found?.[1] === undefined)
    throw new Error('infra/keycloak/README.md documents no TOTP secret');
  return found[1];
}

function totp(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const hash = createHmac('sha1', Buffer.from(secret, 'utf8')).update(counter).digest();
  const offset = (hash[hash.length - 1] ?? 0) & 0xf;
  return ((hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

export async function signInAsOwner(page: Page, to = '/'): Promise<void> {
  await page.goto(to);
  await page.waitForURL(/\/realms\/staff\/protocol\/openid-connect\/auth/);
  await page.getByRole('textbox', { name: /username/i }).fill('owner');
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill('owner');
  await page.getByRole('button', { name: /sign in|log in/i }).click();

  const secret = devTotpSecret();
  const otp = page.locator('input[name="otp"]');
  // A code already used in this 30 s window is refused (code reuse is off); the policy's look-ahead
  // of one window accepts the next one.
  for (const at of [Date.now(), Date.now() + 30_000]) {
    await otp.waitFor();
    await otp.fill(totp(secret, at));
    await page.getByRole('button', { name: /sign in|log in|submit/i }).click();
    await page.waitForLoadState('load');
    if (!page.url().includes('/realms/staff/')) return;
  }
  throw new Error('owner TOTP was refused twice');
}
