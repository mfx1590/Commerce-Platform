/**
 * Reusable objects: the blocks a marketer composes a page from, plus the small value objects
 * (link, CTA, SEO, image with alt text) they are built on. Documents live in `documents.ts`.
 */

import { defineArrayMember, defineField, defineType } from './define.js';
import { embed } from './embed.js';

/**
 * A storefront path (`/en-GB/products` — exactly one leading slash, so `//host` is not a path) or
 * an absolute `https://` URL. Nothing else: no `http:`, `javascript:`, `mailto:` or
 * protocol-relative links.
 */
export const HREF_PATTERN = /^(?:\/(?!\/)|https:\/\/[^\s/?#]+)/;

const HREF_RULE = (label: string) =>
  defineField({
    name: 'href',
    title: label,
    type: 'string',
    description: 'A path on this storefront (starts with /) or a full https:// URL',
    validation: (rule) =>
      rule.required().regex(HREF_PATTERN, { name: 'a storefront path (/…) or an https:// URL' }),
  });

/** Sanity's `image` with a mandatory `alt`: an image without alt text cannot be published. */
export const imageWithAlt = defineType({
  name: 'imageWithAlt',
  title: 'Image',
  type: 'image',
  options: { hotspot: true },
  fields: [
    defineField({
      name: 'alt',
      title: 'Alternative text',
      type: 'string',
      description: 'What the image shows, for screen readers and when it fails to load',
      validation: (rule) => rule.required().max(160),
    }),
  ],
});

export const link = defineType({
  name: 'link',
  title: 'Link',
  type: 'object',
  fields: [
    defineField({
      name: 'label',
      title: 'Label',
      type: 'string',
      validation: (rule) => rule.required().max(60),
    }),
    HREF_RULE('Destination'),
    defineField({
      name: 'openInNewTab',
      title: 'Open in a new tab',
      type: 'boolean',
      initialValue: false,
    }),
  ],
  preview: { select: { title: 'label', subtitle: 'href' } },
});

export const cta = defineType({
  name: 'cta',
  title: 'Call to action',
  type: 'object',
  fields: [
    defineField({
      name: 'label',
      title: 'Button text',
      type: 'string',
      validation: (rule) => rule.required().max(40),
    }),
    HREF_RULE('Destination'),
    defineField({
      name: 'variant',
      title: 'Style',
      type: 'string',
      options: {
        list: [
          { title: 'Primary', value: 'primary' },
          { title: 'Secondary', value: 'secondary' },
        ],
        layout: 'radio',
      },
      initialValue: 'primary',
      validation: (rule) => rule.required(),
    }),
  ],
  preview: { select: { title: 'label', subtitle: 'href' } },
});

export const seo = defineType({
  name: 'seo',
  title: 'SEO',
  type: 'object',
  fields: [
    defineField({
      name: 'metaTitle',
      title: 'Meta title',
      type: 'string',
      description:
        'Falls back to the document title. Search engines truncate after ~60 characters.',
      validation: (rule) => rule.max(70),
    }),
    defineField({
      name: 'metaDescription',
      title: 'Meta description',
      type: 'text',
      rows: 3,
      validation: (rule) => rule.max(160),
    }),
    defineField({
      name: 'ogImage',
      title: 'Share image',
      type: 'imageWithAlt',
      description: 'Shown when the page is shared on social networks (1200×630 works best)',
    }),
    defineField({
      name: 'noIndex',
      title: 'Hide from search engines',
      type: 'boolean',
      initialValue: false,
    }),
  ],
});

/** Portable text used by every rich-text field; links are the only annotation. */
export const portableTextBlock = defineArrayMember({
  type: 'block',
  styles: [
    { title: 'Normal', value: 'normal' },
    { title: 'Heading 2', value: 'h2' },
    { title: 'Heading 3', value: 'h3' },
    { title: 'Quote', value: 'blockquote' },
  ],
  lists: [
    { title: 'Bullet', value: 'bullet' },
    { title: 'Numbered', value: 'number' },
  ],
  marks: {
    decorators: [
      { title: 'Bold', value: 'strong' },
      { title: 'Italic', value: 'em' },
    ],
    annotations: [
      defineArrayMember({
        name: 'link',
        title: 'Link',
        type: 'object',
        fields: [HREF_RULE('Destination')],
      }),
    ],
  },
});

export const hero = defineType({
  name: 'hero',
  title: 'Hero',
  type: 'object',
  fields: [
    defineField({
      name: 'eyebrow',
      title: 'Eyebrow',
      type: 'string',
      description: 'Short line above the headline, e.g. "New season"',
      validation: (rule) => rule.max(40),
    }),
    defineField({
      name: 'headline',
      title: 'Headline',
      type: 'string',
      validation: (rule) => rule.required().max(90),
    }),
    defineField({
      name: 'subheadline',
      title: 'Subheadline',
      type: 'text',
      rows: 2,
      validation: (rule) => rule.max(200),
    }),
    defineField({ name: 'image', title: 'Image', type: 'imageWithAlt' }),
    defineField({
      name: 'ctas',
      title: 'Buttons',
      type: 'array',
      of: [defineArrayMember({ type: 'cta' })],
      validation: (rule) => rule.max(2),
    }),
    defineField({
      name: 'layout',
      title: 'Layout',
      type: 'string',
      options: {
        list: [
          { title: 'Image right', value: 'image-right' },
          { title: 'Image left', value: 'image-left' },
          { title: 'Full bleed', value: 'full-bleed' },
        ],
      },
      initialValue: 'image-right',
    }),
  ],
  preview: { select: { title: 'headline', subtitle: 'eyebrow', media: 'image' } },
});

export const richText = defineType({
  name: 'richText',
  title: 'Text',
  type: 'object',
  fields: [
    defineField({
      name: 'content',
      title: 'Content',
      type: 'array',
      of: [portableTextBlock, defineArrayMember({ type: 'imageWithAlt' })],
      validation: (rule) => rule.required(),
    }),
  ],
  preview: {
    select: { blocks: 'content' },
    prepare: (selection) => {
      const blocks =
        (selection['blocks'] as { children?: { text?: string }[] }[] | undefined) ?? [];
      const text = blocks
        .flatMap((block) => block.children ?? [])
        .map((child) => child.text ?? '')
        .join(' ')
        .trim();
      return { title: text ? text.slice(0, 80) : 'Text', subtitle: 'Text block' };
    },
  },
});

export const imageBlock = defineType({
  name: 'imageBlock',
  title: 'Image',
  type: 'object',
  fields: [
    defineField({
      name: 'image',
      title: 'Image',
      type: 'imageWithAlt',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'caption',
      title: 'Caption',
      type: 'string',
      validation: (rule) => rule.max(200),
    }),
    defineField({
      name: 'width',
      title: 'Width',
      type: 'string',
      options: {
        list: [
          { title: 'Content width', value: 'content' },
          { title: 'Wide', value: 'wide' },
        ],
      },
      initialValue: 'content',
    }),
  ],
  preview: { select: { title: 'caption', media: 'image' } },
});

/** kebab-case, the shape of `product.handle` in the Store API (docs/domain.md conventions). */
export const PRODUCT_HANDLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * A product told as a story: copy and an image from the CMS around a product the storefront loads
 * live from the Store API by handle — price, stock and the buy button are never CMS data (ADR 0004).
 */
export const productStory = defineType({
  name: 'productStory',
  title: 'Product story',
  type: 'object',
  fields: [
    defineField({
      name: 'productHandle',
      title: 'Product handle',
      type: 'string',
      description: 'The product URL slug in the shop, e.g. "alpine-backpack"',
      validation: (rule) =>
        rule.required().regex(PRODUCT_HANDLE_PATTERN, { name: 'kebab-case product handle' }),
    }),
    defineField({
      name: 'headline',
      title: 'Headline',
      type: 'string',
      validation: (rule) => rule.required().max(90),
    }),
    defineField({
      name: 'body',
      title: 'Story',
      type: 'array',
      of: [portableTextBlock],
    }),
    defineField({ name: 'image', title: 'Image', type: 'imageWithAlt' }),
    defineField({ name: 'cta', title: 'Button', type: 'cta' }),
  ],
  preview: { select: { title: 'headline', subtitle: 'productHandle', media: 'image' } },
});

export const navItem = defineType({
  name: 'navItem',
  title: 'Navigation item',
  type: 'object',
  fields: [
    defineField({
      name: 'label',
      title: 'Label',
      type: 'string',
      validation: (rule) => rule.required().max(40),
    }),
    HREF_RULE('Destination'),
    defineField({
      name: 'children',
      title: 'Sub-links',
      type: 'array',
      of: [defineArrayMember({ type: 'link' })],
      validation: (rule) => rule.max(12),
    }),
  ],
  preview: { select: { title: 'label', subtitle: 'href' } },
});

export const footerColumn = defineType({
  name: 'footerColumn',
  title: 'Footer column',
  type: 'object',
  fields: [
    defineField({
      name: 'heading',
      title: 'Heading',
      type: 'string',
      validation: (rule) => rule.required().max(40),
    }),
    defineField({
      name: 'links',
      title: 'Links',
      type: 'array',
      of: [defineArrayMember({ type: 'link' })],
      validation: (rule) => rule.required().min(1).max(10),
    }),
  ],
  preview: { select: { title: 'heading' } },
});

/** The blocks a marketer can drop into a page or a campaign landing, in menu order. */
export const pageBlocks = [
  defineArrayMember({ type: 'hero' }),
  defineArrayMember({ type: 'richText' }),
  defineArrayMember({ type: 'imageBlock' }),
  defineArrayMember({ type: 'productStory' }),
  defineArrayMember({ type: 'cta' }),
];

/** Campaign landings may also embed a Builder.io / Framer page or an HTML snippet. */
export const campaignBlocks = [...pageBlocks, defineArrayMember({ type: 'embed' })];

export const objectTypes = [
  embed,
  imageWithAlt,
  link,
  cta,
  seo,
  hero,
  richText,
  imageBlock,
  productStory,
  navItem,
  footerColumn,
];
