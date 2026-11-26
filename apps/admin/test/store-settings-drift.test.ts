/**
 * The drift guard for `store.settings` (#870 item 7).
 *
 * `Store.settings` is `additionalProperties: true` in the contract, so the authoritative list of
 * paths lives in the **core**: `STORE_SETTINGS_SHAPES` in
 * `apps/core/src/modules/registry/settings-schema.ts`. This app mirrors it in
 * `src/lib/settings/fields.ts`, and a mirror without a guard is a lie waiting to happen.
 *
 * It reads the core's file as **text**, deliberately: importing across an app boundary is not
 * allowed here (`@platform/*` public APIs only), and text is enough — the paths are quoted literal
 * keys. It is the same trick `test/action-permissions.test.ts` uses on `admin-api.yaml`.
 *
 * The guard fails in both directions, which is the point:
 *
 * - a path this app edits that the core does **not** read → the form writes something nothing will
 *   ever honour, and the 422 would not even mention it;
 * - a path the core reads that this app neither edits nor has listed as deliberately-not-edited →
 *   somebody added a setting and nobody decided whether the admin should expose it. That is the
 *   failure mode a mirror has, and the reason this test exists rather than a comment.
 *
 * When CONTRACT CHANGE #967 lands, the source of truth becomes the yaml and this file reads that
 * instead; the assertions do not change.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EDITED_PATHS,
  NOT_EDITED_PATHS,
  SETTINGS_CARDS,
  CONFIRM_PATHS,
} from '@/lib/settings/fields';

const SCHEMA = resolve(process.cwd(), '../../apps/core/src/modules/registry/settings-schema.ts');

/** The quoted keys of `STORE_SETTINGS_SHAPES`, in the order the core lists them. */
function corePaths(): string[] {
  const source = readFileSync(SCHEMA, 'utf8');
  const start = source.indexOf('export const STORE_SETTINGS_SHAPES');
  expect(start, 'STORE_SETTINGS_SHAPES moved or was renamed in the core').toBeGreaterThan(-1);
  const end = source.indexOf('\n};', start);
  expect(end, 'could not find the end of STORE_SETTINGS_SHAPES').toBeGreaterThan(start);
  const body = source.slice(start, end);
  const paths = new Set<string>();
  // `payment: object,` and `'payment.invoice_allowed': boolean,` — bare and quoted keys alike.
  for (const match of body.matchAll(/^\s*(?:'([^']+)'|([a-z_][\w]*))\s*:/gm)) {
    const key = match[1] ?? match[2];
    if (key !== undefined && key !== 'STORE_SETTINGS_SHAPES') paths.add(key);
  }
  return [...paths];
}

describe('the admin and the core agree about store.settings', () => {
  it('reads a non-trivial list out of the core, so a silent parse failure cannot pass', () => {
    const paths = corePaths();
    expect(paths.length).toBeGreaterThan(20);
    // Spot-check one of each shape so a regex that matched nothing useful fails here.
    expect(paths).toContain('tax.prices_include_tax');
    expect(paths).toContain('support_refund_limit_minor');
    expect(paths).toContain('fulfillment.routing.countries');
  });

  it('edits nothing the core does not read', () => {
    const core = new Set(corePaths());
    const invented = EDITED_PATHS.filter((path) => !core.has(path));
    expect(invented, 'these paths are not read by the core, so writing them does nothing').toEqual(
      [],
    );
  });

  it('accounts for every path the core reads — edited, or explicitly not', () => {
    const accounted = new Set([...EDITED_PATHS, ...NOT_EDITED_PATHS]);
    const unaccounted = corePaths().filter((path) => !accounted.has(path));
    expect(
      unaccounted,
      'the core reads these and this app has not decided about them: add them to a card, or to NOT_EDITED_PATHS with a reason',
    ).toEqual([]);
  });

  it('never lists a path as both edited and not edited', () => {
    const both = EDITED_PATHS.filter((path) => NOT_EDITED_PATHS.includes(path));
    expect(both).toEqual([]);
  });

  it('confirms only paths that exist in the core', () => {
    const core = new Set(corePaths());
    expect(CONFIRM_PATHS.filter((path) => !core.has(path))).toEqual([]);
  });

  it('gives every edited field an option list or bounds, as the core requires', () => {
    for (const card of SETTINGS_CARDS) {
      for (const field of card.fields) {
        if (field.kind === 'enum' || field.kind === 'enumArray') {
          expect(field.options?.length, `${field.path} needs its options`).toBeGreaterThan(0);
        }
        if (field.kind === 'integer') {
          expect(typeof field.min, `${field.path} needs a minimum`).toBe('number');
        }
        if (field.kind === 'text') {
          expect(typeof field.maxLength, `${field.path} needs a maximum length`).toBe('number');
        }
        // `textList` and `countryMap` are free-form by the core's own check (array of strings /
        // object of country -> code), so they carry no bounds — but they must carry a hint, because
        // nothing about "one per line" or "NL = wh-eu" is guessable.
        if (field.kind === 'textList' || field.kind === 'countryMap') {
          expect(field.hint, `${field.path} needs a hint explaining its format`).toBeTruthy();
        }
      }
    }
  });

  it("matches the core's own enums and bounds, not a guess at them", () => {
    const source = readFileSync(SCHEMA, 'utf8');
    // `oneOf('table', 'stripe')`, `arrayOf('rules', 'radar')`, `textOfLength(1, 500)`.
    expect(source).toContain("'tax.provider': oneOf('table', 'stripe')");
    expect(source).toContain("'fraud.providers': arrayOf('rules', 'radar')");
    expect(source).toContain("'fraud.country_mismatch': oneOf('review', 'allow')");
    expect(source).toContain("'fraud.radar_highest': oneOf('block', 'review')");
    expect(source).toContain("'content.brand_voice': textOfLength(1, 500)");
    expect(source).toContain("'content.audience': textOfLength(1, 200)");

    const byPath = new Map(
      SETTINGS_CARDS.flatMap((card) => card.fields).map((field) => [field.path, field]),
    );
    expect(byPath.get('tax.provider')?.options).toEqual(['table', 'stripe']);
    expect(byPath.get('fraud.providers')?.options).toEqual(['rules', 'radar']);
    expect(byPath.get('fraud.country_mismatch')?.options).toEqual(['review', 'allow']);
    expect(byPath.get('fraud.radar_highest')?.options).toEqual(['block', 'review']);
    expect(byPath.get('content.brand_voice')?.maxLength).toBe(500);
    expect(byPath.get('content.audience')?.maxLength).toBe(200);
  });
});
