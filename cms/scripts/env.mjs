// Loads the repo-root `.env` (the file `pnpm dev` creates from `.env.example`) into process.env
// without overriding variables already set. Deliberately tiny: KEY=VALUE lines, `#` comments,
// optional surrounding quotes. Values are never printed.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

export function loadRootEnv(env = process.env) {
  let text;
  try {
    text = readFileSync(resolve(ROOT, '.env'), 'utf8');
  } catch {
    return env;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined) env[key] = value;
  }
  return env;
}
