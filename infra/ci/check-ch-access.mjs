// CI guard for #648: read the ch:migrate log and fail unless its "access" line lists every named user as APPLIED.
// A user under "skipped" means users.d (or another XML source) still defines it, so the SQL grants are not in force.
// Usage: node infra/ci/check-ch-access.mjs <log> <user>...
import { readFileSync } from 'node:fs';

const [log, ...users] = process.argv.slice(2);
if (!log || users.length === 0) {
  console.error('usage: check-ch-access.mjs <log> <user>...');
  process.exit(2);
}
const access = readFileSync(log, 'utf8')
  .split('\n')
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .find((o) => o && o.event === 'access');
if (!access) {
  console.error('check-ch-access: no {"event":"access"} line in the ch:migrate output');
  process.exit(1);
}
const applied = new Set((access.applied ?? []).map((a) => a.user));
const missing = users.filter((u) => !applied.has(u));
if (missing.length > 0) {
  console.error(
    `check-ch-access: not applied by SQL: ${missing.join(', ')} (skipped: ${JSON.stringify(access.skipped ?? [])})`,
  );
  process.exit(1);
}
console.info(`check-ch-access: applied by SQL: ${users.join(', ')}`);
