// Rewrites image.repository and image.tag in a Helm values file, changing nothing else.
//
//   REPO=… TAG=… node infra/ci/set-image.mjs infra/helm/values/core/values-staging.yaml
//
// Deliberately not `yq -i`: yq re-emits the whole document and drops blank lines, so the committed
// file stops matching what prettier produces. The deploy commit carries [skip ci], so nothing would
// notice — until `format:check` failed on somebody else's unrelated pull request. Replacing two
// values in place leaves every other byte alone, which makes that impossible by construction.
import { readFileSync, writeFileSync } from 'node:fs';

const [file] = process.argv.slice(2);
const repo = process.env.REPO;
const tag = process.env.TAG;

if (!file || !repo || !tag) {
  console.error('usage: REPO=… TAG=… node infra/ci/set-image.mjs <values file>');
  process.exit(2);
}

// A tag that is not a git sha means something upstream went wrong — and the chart would reject it
// later anyway. Failing here keeps a bad value out of git rather than out of a render.
if (!/^[0-9a-f]{40}$/.test(tag)) {
  console.error(`refusing to write "${tag}" as an image tag: expected a 40-character git sha`);
  process.exit(2);
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const before = readFileSync(file, 'utf8');

// The first `repository:` and `tag:` in these files are the ones under `image:`. Anchored to the
// whole line, so a value containing a colon cannot confuse the match.
let after = before.replace(/^(\s*repository:\s*).*$/m, `$1${repo}`);
after = after.replace(/^(\s*tag:\s*).*$/m, `$1'${tag}'`);

const checks = [
  ['repository', new RegExp(`^\\s*repository: ${escape(repo)}$`, 'm')],
  ['tag', new RegExp(`^\\s*tag: '${escape(tag)}'$`, 'm')],
];

for (const [name, pattern] of checks) {
  if (!pattern.test(after)) {
    console.error(`failed to set image.${name} in ${file} — has the file's shape changed?`);
    process.exit(1);
  }
}

// Everything except those two lines must be untouched.
const strip = (s) => s.split('\n').filter((l) => !/^\s*(repository|tag):/.test(l));
if (strip(before).join('\n') !== strip(after).join('\n')) {
  console.error(
    `refusing to write ${file}: the edit changed more than image.repository and image.tag`,
  );
  process.exit(1);
}

if (after !== before) writeFileSync(file, after);
console.info(`${file}: ${repo}:${tag.slice(0, 12)}`);
