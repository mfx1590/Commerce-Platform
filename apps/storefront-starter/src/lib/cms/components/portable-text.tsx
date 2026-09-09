import type { PortableTextBlock, PortableTextSpan, RichTextContent } from '@platform/cms';
import type { ReactNode } from 'react';
import { Link } from '@/i18n/navigation';
import type { ContentContext } from '../content';
import { SanityImage } from './sanity-image';

/**
 * Renders the portable text our `richText` schema allows — styles normal/h2/h3/blockquote, bullet
 * and numbered lists, strong/em, and link annotations — and nothing else, so a new mark in the
 * Studio is a visible gap here rather than unexpected HTML. Hand-rolled instead of
 * `@portabletext/react` to keep the storefront's dependency list where window 3 left it.
 */

function isExternal(href: string): boolean {
  return /^https?:\/\//.test(href);
}

function Spans({ block }: { block: PortableTextBlock }) {
  return block.children.map((span: PortableTextSpan) => {
    let node: ReactNode = span.text;
    for (const mark of span.marks ?? []) {
      if (mark === 'strong') node = <strong key={mark}>{node}</strong>;
      else if (mark === 'em') node = <em key={mark}>{node}</em>;
      else {
        const def = block.markDefs?.find((d) => d._key === mark);
        if (def?._type === 'link') {
          node = isExternal(def.href) ? (
            <a key={mark} href={def.href} rel="noopener noreferrer" className="underline">
              {node}
            </a>
          ) : (
            <Link key={mark} href={def.href} className="underline">
              {node}
            </Link>
          );
        }
      }
    }
    return <span key={span._key}>{node}</span>;
  });
}

function Block({ block }: { block: PortableTextBlock }) {
  switch (block.style) {
    case 'h2':
      return (
        <h2 className="mt-8 text-2xl font-semibold">
          <Spans block={block} />
        </h2>
      );
    case 'h3':
      return (
        <h3 className="mt-6 text-xl font-semibold">
          <Spans block={block} />
        </h3>
      );
    case 'blockquote':
      return (
        <blockquote className="border-l-4 border-border pl-4 italic text-muted-foreground">
          <Spans block={block} />
        </blockquote>
      );
    default:
      return (
        <p className="leading-relaxed">
          <Spans block={block} />
        </p>
      );
  }
}

type Item = RichTextContent[number];

/** Consecutive list items of the same kind become one `<ul>` / `<ol>`. */
function group(
  content: RichTextContent,
): (Item | { list: 'bullet' | 'number'; items: PortableTextBlock[] })[] {
  const out: (Item | { list: 'bullet' | 'number'; items: PortableTextBlock[] })[] = [];
  for (const item of content) {
    const listItem = item._type === 'block' ? item.listItem : undefined;
    const last = out[out.length - 1];
    if (listItem && item._type === 'block') {
      if (last && 'list' in last && last.list === listItem) last.items.push(item);
      else out.push({ list: listItem, items: [item] });
    } else {
      out.push(item);
    }
  }
  return out;
}

export function PortableText({ value, ctx }: { value: RichTextContent; ctx: ContentContext }) {
  return (
    <div className="flex flex-col gap-4">
      {group(value).map((entry, index) => {
        if ('list' in entry) {
          const ListTag = entry.list === 'number' ? 'ol' : 'ul';
          return (
            <ListTag
              key={entry.items[0]?._key ?? index}
              className={entry.list === 'number' ? 'list-decimal pl-6' : 'list-disc pl-6'}
            >
              {entry.items.map((item) => (
                <li key={item._key}>
                  <Spans block={item} />
                </li>
              ))}
            </ListTag>
          );
        }
        if (entry._type === 'image') {
          return <SanityImage key={entry._key} image={entry} ctx={ctx} className="rounded-lg" />;
        }
        return <Block key={entry._key} block={entry} />;
      })}
    </div>
  );
}
