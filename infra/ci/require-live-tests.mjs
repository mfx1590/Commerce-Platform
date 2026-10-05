#!/usr/bin/env node
/**
 * Fails unless every named live block in a vitest JSON report RAN (#297).
 *
 *   node infra/ci/require-live-tests.mjs <vitest-report.json> '<describe title>' ['<describe title>' ...]
 *
 * The core's live suites gate themselves: `describe.runIf(live)`, where `live` means Keycloak (and for
 * some, OpenFGA and a database) answered a probe. That is right on a laptop without the stack and
 * wrong in CI, where a probe that misses — a port, a realm name, a slow container — turns the whole
 * block into "skipped" and the step stays green while testing nothing. This reads the report instead
 * of editing the tests: for each title, at least one test must sit under it and every one of them must
 * have passed. Skipped, todo or missing counts as a failure, with the reason printed.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** @returns {{ title: string, total: number, passed: number, other: Record<string, number> }[]} */
export function liveCounts(report, titles) {
  const tests = (report.testResults ?? []).flatMap((file) => file.assertionResults ?? []);
  return titles.map((title) => {
    const under = tests.filter((t) => (t.ancestorTitles ?? []).includes(title));
    const other = {};
    for (const t of under) if (t.status !== 'passed') other[t.status] = (other[t.status] ?? 0) + 1;
    return {
      title,
      total: under.length,
      passed: under.length - Object.values(other).reduce((a, b) => a + b, 0),
      other,
    };
  });
}

/** Human-readable failures; empty when every block ran and passed. */
export function liveFailures(counts) {
  const out = [];
  for (const c of counts) {
    if (c.total === 0)
      out.push(`"${c.title}": no tests found under this title — renamed, or never collected`);
    else if (c.passed !== c.total) {
      out.push(
        `"${c.title}": ${c.passed}/${c.total} passed (${JSON.stringify(c.other)}) — a skipped live block means the stack probe missed`,
      );
    }
  }
  return out;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [reportPath, ...titles] = process.argv.slice(2);
  if (!reportPath || titles.length === 0) {
    console.error('usage: require-live-tests.mjs <vitest-report.json> <describe title>...');
    process.exit(2);
  }
  const counts = liveCounts(JSON.parse(readFileSync(reportPath, 'utf8')), titles);
  for (const c of counts) console.info(`live: "${c.title}" — ${c.passed}/${c.total} passed`);
  const failures = liveFailures(counts);
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(failures.length ? 1 : 0);
}
