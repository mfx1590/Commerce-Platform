#!/usr/bin/env node
/**
 * The production-dependency gate (#730, plan D4).
 *
 *   pnpm audit --prod --json > audit.json; node infra/ci/audit-gate.mjs audit.json [allow-list.json]
 *
 * Reads `pnpm audit --prod --json` (pnpm resolves PRODUCTION dependencies from pnpm-lock.yaml and asks the npm
 * advisory database) and fails the step when an advisory at or above the allow-list's `threshold` is present and
 * not allowed:
 *
 *   - not on the allow-list                         → FAIL (a new known-vulnerable production package)
 *   - on it, but its `expires` date has passed      → FAIL (an exception nobody renewed or fixed)
 *   - on it and in date                             → allowed, printed with its owner and expiry
 *
 * Below the threshold, advisories are counted, not failed. An allow-list entry that matches no advisory any more
 * is reported as stale (the bump landed: delete it). A report that is not a pnpm audit report — the advisory API
 * failed, pnpm printed an error — fails CLOSED: a gate that passes because it could not look is not a gate.
 *
 * AUDIT_TODAY=YYYY-MM-DD fixes "today" (self-test). With $GITHUB_STEP_SUMMARY set, the table goes there too.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];
const rank = (s) => SEVERITIES.indexOf(String(s).toLowerCase());
export const DEFAULT_ALLOWLIST = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'security',
  'audit-allowlist.json',
);

/** The advisories in a pnpm audit report, one per advisory, with the apps whose dependency tree pulls them in. */
export function advisoriesOf(report) {
  if (!report || typeof report !== 'object' || !report.advisories || !report.metadata) {
    throw new Error(
      'not a pnpm audit --json report (no advisories/metadata): the advisory lookup failed',
    );
  }
  return Object.values(report.advisories).map((a) => {
    const apps = new Set();
    const versions = new Set();
    for (const f of a.findings ?? []) {
      if (f.version) versions.add(f.version);
      for (const p of f.paths ?? []) apps.add(p.split('>')[0].replace(/__/g, '/'));
    }
    return {
      id: a.github_advisory_id || String(a.id),
      package: a.module_name,
      severity: String(a.severity).toLowerCase(),
      title: a.title,
      url: a.url,
      versions: [...versions],
      apps: [...apps],
    };
  });
}

/** Decides every advisory against the allow-list. Pure: `today` is a YYYY-MM-DD string. */
export function evaluate(advisories, allowlist, today) {
  const threshold = String(allowlist.threshold ?? 'high').toLowerCase();
  if (rank(threshold) < 0) throw new Error(`unknown threshold "${allowlist.threshold}"`);
  const entries = allowlist.entries ?? [];
  const byId = new Map(entries.map((e) => [e.id, e]));
  const failures = [];
  const allowed = [];
  const below = {};
  for (const a of advisories) {
    if (rank(a.severity) < rank(threshold)) {
      below[a.severity] = (below[a.severity] ?? 0) + 1;
      continue;
    }
    const e = byId.get(a.id);
    if (!e) failures.push({ ...a, reason: 'not on the allow-list' });
    else if (!e.expires || e.expires < today)
      failures.push({ ...a, reason: `allow-list entry expired ${e.expires ?? '(no date)'}` });
    else allowed.push({ ...a, entry: e });
  }
  const present = new Set(advisories.map((a) => a.id));
  const stale = entries.filter((e) => !present.has(e.id));
  return { threshold, failures, allowed, below, stale, ok: failures.length === 0 };
}

export function render(result, today) {
  const L = [];
  L.push(
    `== production dependency audit (pnpm audit --prod), threshold: ${result.threshold} and above, today ${today}`,
  );
  for (const f of result.failures) {
    L.push(
      `FAIL ${f.severity.padEnd(8)} ${f.package}@${f.versions.join(',')} ${f.id} — ${f.reason} (pulled in by ${f.apps.join(', ') || '?'})`,
    );
  }
  for (const a of result.allowed) {
    L.push(
      `allowed ${a.severity.padEnd(8)} ${a.package}@${a.versions.join(',')} ${a.id} — until ${a.entry.expires}, owner ${a.entry.owner ?? '?'}: ${a.entry.reason ?? ''}`,
    );
  }
  for (const s of result.stale) {
    L.push(`stale   ${s.id} (${s.package}) — matches no advisory any more: delete the entry`);
  }
  const below = Object.entries(result.below)
    .map(([k, v]) => `${v} ${k}`)
    .join(', ');
  L.push(`below the threshold (reported, not failed): ${below || 'none'}`);
  L.push(
    result.ok
      ? `== PASS: no ${result.threshold}+ advisory outside the allow-list (${result.allowed.length} allowed, in date)`
      : `== FAIL: ${result.failures.length} ${result.threshold}+ advisory/advisories not allowed`,
  );
  return L.join('\n');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [reportPath, allowPath = DEFAULT_ALLOWLIST] = process.argv.slice(2);
  if (!reportPath) {
    console.error('usage: audit-gate.mjs <pnpm-audit.json> [allow-list.json]');
    process.exit(2);
  }
  const today = process.env.AUDIT_TODAY || new Date().toISOString().slice(0, 10);
  let text;
  try {
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    const allowlist = JSON.parse(readFileSync(allowPath, 'utf8'));
    const result = evaluate(advisoriesOf(report), allowlist, today);
    text = render(result, today);
    console.info(text);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\`\`\`\n${text}\n\`\`\`\n`);
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    console.error(`FAIL the audit could not be evaluated: ${error.message}`);
    process.exit(1);
  }
}
