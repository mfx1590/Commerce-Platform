import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The launch gate: **no `[[PLACEHOLDER]]` may reach production** (#437, brand B's LAUNCH.md row on
 * its legal placeholders).
 *
 * This is a **launch** gate, not a CI gate, and the difference is the whole design. Brand B's legal
 * content is full of placeholders today and that is correct — the texts are drafted and waiting on
 * the owner's company details and a lawyer's review. A test that failed on them now would be red for
 * weeks and would be disabled, which is how a launch check becomes decoration.
 *
 * So it runs only under `LAUNCH_GATE=1`:
 *
 * ```bash
 * LAUNCH_GATE=1 pnpm test --filter @platform/storefront-brand-b
 * ```
 *
 * Today that **fails**, listing what is left. The day the content is finished it passes, and the
 * command belongs in the go-live checklist rather than in the ordinary suite.
 *
 * Scope is every authored content file, not only the imprint: a `[[` anywhere in `cms/brand-b/content`
 * is equally unshippable, and naming the file it came from is more useful than naming the rule. The
 * brand's `README.md` is deliberately **not** scanned — it documents the placeholder syntax, so it
 * contains `[[` on purpose.
 */

const GATE = process.env.LAUNCH_GATE === '1';
const CONTENT_DIR = new URL('../../../../cms/brand-b/content/', import.meta.url);

/** `[[SOMETHING]]`, the placeholder syntax `cms/brand-b/README.md` documents. */
const PLACEHOLDER = /\[\[[^\]]+\]\]/g;

interface Found {
  file: string;
  placeholder: string;
}

function placeholdersInContent(): Found[] {
  const found: Found[] = [];
  for (const file of readdirSync(CONTENT_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()) {
    const text = readFileSync(new URL(file, CONTENT_DIR), 'utf8');
    for (const match of text.matchAll(PLACEHOLDER)) {
      found.push({ file, placeholder: match[0] });
    }
  }
  return found;
}

describe('the launch gate (LAUNCH_GATE=1)', () => {
  it.skipIf(!GATE)('leaves no [[PLACEHOLDER]] anywhere in brand B content', () => {
    const found = placeholdersInContent();

    // Grouped and counted, because "48 placeholders remain" is not actionable and
    // "[[COMPANY_LEGAL_NAME]] ×6 in legal.json" is.
    const byPlaceholder = new Map<string, { count: number; files: Set<string> }>();
    for (const { file, placeholder } of found) {
      const entry = byPlaceholder.get(placeholder) ?? { count: 0, files: new Set<string>() };
      entry.count += 1;
      entry.files.add(file);
      byPlaceholder.set(placeholder, entry);
    }
    const report = [...byPlaceholder.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, { count, files }]) => `  ${name} ×${count} in ${[...files].sort().join(', ')}`)
      .join('\n');

    expect(
      found,
      `brand B still has ${found.length} placeholder(s) (${byPlaceholder.size} distinct) — ` +
        `each needs the owner's real value before go-live:\n${report}`,
    ).toEqual([]);
  });

  // Runs always, and deliberately against a SAMPLE rather than the real content: a gate whose
  // scanner silently stopped matching would pass by finding nothing, which is the one failure mode a
  // launch gate cannot afford. Checking it against the content instead would mean asserting that
  // placeholders still exist — a test that turns red on the day the work is finished, and so a test
  // that gets deleted carelessly. This one keeps working after go-live.
  it('the scanner matches the placeholder syntax and nothing else', () => {
    const sample =
      '{"imprint":"[[COMPANY_LEGAL_NAME]], [[CITY]]","note":"brackets [like] this are fine",' +
      '"array":"[1] [2]","empty":"[[]]"}';
    expect([...sample.matchAll(PLACEHOLDER)].map((match) => match[0])).toEqual([
      '[[COMPANY_LEGAL_NAME]]',
      '[[CITY]]',
    ]);
    // Single brackets, bare numbers and an empty `[[]]` are not placeholders and must not trip it.
    // A fresh non-global copy on purpose: `.test()` on a `/g` regex advances `lastIndex`, so reusing
    // PLACEHOLDER here would make this assertion depend on what ran before it.
    expect(new RegExp(PLACEHOLDER.source).test('no placeholders here [x] [[]]')).toBe(false);
  });
});
