import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StoreFacts } from '@/components/store-facts';

/**
 * #286. HTML allows exactly one wrapper between a `<dl>` and its terms: `dl > div > dt/dd`. The
 * home page rendered `dl > div > div > dt` — a card and its content — which orphans every `dt` and
 * `dd` from the list. axe reports it as two serious rules (`dlitem`, `definition-list`); Lighthouse
 * never saw it because the home page is not among the URLs it audits. The structure is asserted on
 * the rendered markup, so a component boundary cannot hide an element from the check.
 */

interface Node {
  tag: string;
  parent: Node | null;
  children: Node[];
}

/** Enough of a parser for markup React rendered: balanced tags, no void elements in this tree. */
function parse(html: string): Node {
  const root: Node = { tag: '#root', parent: null, children: [] };
  let current = root;
  for (const match of html.matchAll(/<(\/?)([a-z0-9]+)[^>]*>/g)) {
    const [, closing, tag] = match;
    if (closing === '/') {
      expect(current.tag, `</${tag}> closes the element that is open`).toBe(tag);
      current = current.parent ?? root;
    } else {
      const node: Node = { tag: tag!, parent: current, children: [] };
      current.children.push(node);
      current = node;
    }
  }
  return root;
}

function all(node: Node, tag: string): Node[] {
  return node.children.flatMap((child) => [
    ...(child.tag === tag ? [child] : []),
    ...all(child, tag),
  ]);
}

const facts = [
  { label: 'Store code', value: 'brand-a' },
  { label: 'Currencies', value: 'EUR, GBP', hint: 'Default: EUR' },
];

describe('StoreFacts', () => {
  const tree = parse(renderToStaticMarkup(createElement(StoreFacts, { facts })));
  const [list] = all(tree, 'dl');

  it('renders one description list with a term and a description per fact', () => {
    expect(all(tree, 'dl')).toHaveLength(1);
    expect(all(tree, 'dt')).toHaveLength(facts.length);
    // The hint is a second description of the same term.
    expect(all(tree, 'dd')).toHaveLength(facts.length + 1);
  });

  it('gives the list only groups as direct children (axe: definition-list)', () => {
    expect(list!.children.map((child) => child.tag)).toEqual(facts.map(() => 'div'));
    for (const group of list!.children) {
      const inside = group.children.map((child) => child.tag);
      expect(
        inside.every((tag) => tag === 'dt' || tag === 'dd'),
        `a group holds only dt and dd, found: ${inside.join(', ')}`,
      ).toBe(true);
    }
  });

  it('keeps every term and description inside the list, at most one wrapper deep (axe: dlitem)', () => {
    for (const item of [...all(tree, 'dt'), ...all(tree, 'dd')]) {
      const parent = item.parent!;
      const contained =
        parent.tag === 'dl' || (parent.tag === 'div' && parent.parent?.tag === 'dl');
      expect(contained, `<${item.tag}> sits under ${parent.parent?.tag} > ${parent.tag}`).toBe(
        true,
      );
    }
  });
});
