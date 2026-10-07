// vitest globalSetup (packages/auth-sdk/vitest.config.ts): deletes the shared owner-token file once at the END
// of a local run, when this run created it (#406). Deleting it per test file, as `forgetStaffToken()` did in
// each afterAll, made every file that needs owner grant cold again — three one-time codes in one 40 s run, the
// collision #346 removed between processes. The agreed rule still holds: the suite that created the file deletes
// it, where the suite is the run. In CI (`CI` / `RUNNER_TEMP`) the file lives for the job and the runner
// discards it; a file that already existed when the run started belongs to another window and is left alone.
import { stat, unlink } from 'node:fs/promises';
import { ownerTokenFile } from '../src/testing.js';

export default async function setup(): Promise<() => Promise<void>> {
  const file = ownerTokenFile();
  const existedBefore = await stat(file).then(
    () => true,
    () => false,
  );
  return async () => {
    if (process.env.CI || process.env.RUNNER_TEMP || existedBefore) return;
    await unlink(file).catch(() => undefined);
  };
}
