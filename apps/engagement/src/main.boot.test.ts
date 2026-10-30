// The BOOT, as a child process — the only way to prove "a bad configuration stops the service" rather than
// "a function throws" (#590 review).
//
// This file exists because of a real defect: the unknown-store check threw AFTER the ops consumer had already
// started, so `process.exitCode = 1` never took effect. The running consumer kept the event loop alive, the
// SIGTERM handlers were never registered, and the service stayed up with a configuration it had just refused
// — while the crash line said `error_class: "Error"` and threw away the name of the offending variable.
//
// So the assertions here are deliberately about the PROCESS: the exit code, the crash line on stderr, and the
// absence of any `started` line. Nothing in-process can check those.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let db: TestDatabase;
let appUrl: string;

beforeAll(async () => {
  db = await createTestDatabase('platform_engagement_boot');
  // The stores are the point: the check compares the override keys against the organization's real codes.
  await seed(db.owner);
  const base =
    process.env.DATABASE_URL_APP ??
    process.env.DATABASE_URL!.replace(/\/\/[^@]+@/, '//platform_app:platform_app@');
  const u = new URL(base);
  u.pathname = `/${db.name}`;
  appUrl = u.toString();
}, 180_000);

afterAll(async () => {
  await db.drop();
});

interface Boot {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Boots `src/main.ts` with this environment and waits for it to exit. */
async function boot(
  env: Record<string, string>,
  ms = 60_000,
  argv: readonly string[] = [],
): Promise<Boot> {
  return new Promise<Boot>((done, fail) => {
    const child = spawn(`pnpm exec tsx src/main.ts ${argv.join(' ')}`.trim(), {
      cwd: pkgRoot,
      shell: true,
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    const timer = setTimeout(() => {
      // A boot that does NOT exit is the defect itself, so it fails loudly rather than hanging the suite.
      child.kill('SIGKILL');
      fail(
        new Error(
          `the boot did not exit within ${ms} ms\n--- stdout\n${stdout}\n--- stderr\n${stderr}`,
        ),
      );
    }, ms);
    child.on('error', fail);
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
  });
}

/** The crash line this entry point writes, parsed out of whatever else is on stderr. */
function crashLine(stderr: string): Record<string, unknown> | null {
  for (const line of stderr.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (parsed.event === 'crashed') return parsed;
  }
  return null;
}

describe('the boot refuses a bad consent-mode configuration (#590)', () => {
  it('EXITS NON-ZERO on an override that names no store, and starts nothing', async () => {
    const r = await boot({
      DATABASE_URL_APP: appUrl,
      ENGAGEMENT_CDP_ENABLED: '1',
      ENGAGEMENT_CDP_CONSENT_MODE_BRANDA: 'strict',
    });

    // 1. It really exits, with 2 — the configuration-refusal code since #599, so a supervisor does not
    //    restart a process whose environment has already been refused. (It used to stay up at all: #590.)
    expect(r.code).toBe(2);

    // 2. The crash line names the class AND the variable, so an operator can act on it. The message is
    //    printed for this class only, and only because it is built from variable names and store codes.
    const crash = crashLine(r.stderr);
    expect(crash).not.toBeNull();
    expect(crash?.error_class).toBe('ConsentModeConfigError');
    expect(String(crash?.message)).toContain('ENGAGEMENT_CDP_CONSENT_MODE_BRANDA');
    expect(String(crash?.message)).toContain('brand-a');

    // 3. Nothing started. A consumer or a server that is up is both a wrong configuration running and the
    //    reason the exit code used to be ignored.
    expect(r.stdout).not.toContain('"event":"started"');
  }, 90_000);

  it('EXITS 2 when --drain would join a live consumer group (#646)', async () => {
    // The second medium finding of the #598 re-review, at the process level: a drain reads from the
    // beginning and commits under whatever group it joins, so omitting the override must stop it rather
    // than rebalance the running consumer and move its offsets.
    const r = await boot({ DATABASE_URL_APP: appUrl }, 60_000, ['--drain']);
    expect(r.code).toBe(2);
    const crash = crashLine(r.stderr);
    expect(crash?.error_class).toBe('ConfigRefusedError');
    expect(String(crash?.message)).toContain('--drain refuses the live consumer group');
    expect(String(crash?.message)).toContain('engagement.ops');
    expect(r.stdout).not.toContain('"event":"started"');
  }, 90_000);

  it('EXITS 2 on a per-store consent mode that is set but empty (#644)', async () => {
    // The medium finding, at the process level: an empty per-store override must stop the boot rather than
    // quietly become the global mode. Nothing starts, and the message names the variable.
    const r = await boot({
      DATABASE_URL_APP: appUrl,
      ENGAGEMENT_CDP_ENABLED: '1',
      ENGAGEMENT_CDP_CONSENT_MODE_BRAND_A: '',
    });
    expect(r.code).toBe(2);
    const crash = crashLine(r.stderr);
    expect(crash?.error_class).toBe('ConsentModeConfigError');
    expect(String(crash?.message)).toContain(
      'ENGAGEMENT_CDP_CONSENT_MODE_BRAND_A is set but empty',
    );
    expect(r.stdout).not.toContain('"event":"started"');
  }, 90_000);

  it('EXITS 2 when the DLQ watch would not cover a group this process runs (#599)', async () => {
    // The failure the whole issue is about, at the boot: an explicit watch list that omits a group being
    // consumed. Nothing starts, and the message names the group rather than making an operator diff two
    // variables.
    const r = await boot({
      DATABASE_URL_APP: appUrl,
      ENGAGEMENT_CDP_ENABLED: '1',
      ENGAGEMENT_CDP_GROUP_ID: 'engagement.cdp.int4',
      ENGAGEMENT_DLQ_GROUPS: 'engagement.ops, engagement.cdp',
    });
    expect(r.code).toBe(2);
    const crash = crashLine(r.stderr);
    expect(crash?.error_class).toBe('ConfigRefusedError');
    expect(String(crash?.message)).toContain('engagement.cdp.int4');
    expect(crash?.exit).toBe(2);
    expect(r.stdout).not.toContain('"event":"started"');
  }, 90_000);

  it('EXITS NON-ZERO on an unknown mode value, before it needs a database at all', async () => {
    // The same class, from `resolveConfig` rather than from the store check — so the entry point's handling
    // covers every consent-mode failure and not just the one the review found.
    const r = await boot({
      DATABASE_URL_APP: appUrl,
      ENGAGEMENT_CDP_ENABLED: '1',
      ENGAGEMENT_CDP_CONSENT_MODE: 'strcit',
    });
    expect(r.code).toBe(2);
    const crash = crashLine(r.stderr);
    expect(crash?.error_class).toBe('ConsentModeConfigError');
    expect(String(crash?.message)).toContain('ENGAGEMENT_CDP_CONSENT_MODE');
    expect(r.stdout).not.toContain('"event":"started"');
  }, 90_000);
});
