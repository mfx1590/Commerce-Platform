/**
 * Document types. Every document belongs to exactly one locale: the storefront routes by
 * `/[locale]/...` with next-intl, so a document per `(locale, slug)` maps 1:1 onto a URL and a
 * translation is simply another document (see README, "Adding a locale").
 */

import { ALL_LOCALES, LOCALE_PATTERN } from '../datasets.js';
import { defineArrayMember, defineField, defineType } from './define.js';
import { pageBlocks } from './objects.js';
import { endsAfterStart, uniqueLocale, uniqueLocaleKey, uniqueLocaleSlug } from './validators.js';

const localeField = defineField({
  name: 'locale',
  title: 'Language',
  type: 'string',
  description: 'The storefront language this document is written in',
  options: { list: ALL_LOCALES.map((locale) => ({ title: locale, value: locale })) },
  validation: (rule) => rule.required().regex(LOCALE_PATTERN, { name: 'BCP-47 locale (xx-YY)' }),
});

const slugField = defineField({
  name: 'slug',
  title: 'URL slug',
  type: 'slug',
  description: 'The last part of the page address; unique per language',
  options: { source: 'title', maxLength: 96 },
  validation: (rule) => rule.required().custom(uniqueLocaleSlug),
});

const titleField = defineField({
  name: 'title',
  title: 'Title',
  type: 'string',
  validation: (rule) => rule.required().max(120),
});

const seoField = defineField({ name: 'seo', title: 'SEO', type: 'seo', group: 'seo' });

const contentGroups = [
  { name: 'content', title: 'Content', default: true },
  { name: 'seo', title: 'SEO' },
];

export const page = defineType({
  name: 'page',
  title: 'Page',
  type: 'document',
  groups: contentGroups,
  fields: [
    { ...titleField, group: 'content' },
    { ...slugField, group: 'content' },
    { ...localeField, group: 'content' },
    defineField({ name: 'hero', title: 'Hero', type: 'hero', group: 'content' }),
    defineField({
      name: 'blocks',
      title: 'Blocks',
      type: 'array',
      of: pageBlocks,
      group: 'content',
    }),
    seoField,
  ],
  preview: { select: { title: 'title', subtitle: 'locale' } },
});

export const campaignLanding = defineType({
  name: 'campaignLanding',
  title: 'Campaign landing page',
  type: 'document',
  groups: contentGroups,
  fields: [
    { ...titleField, group: 'content' },
    { ...slugField, group: 'content', description: 'Served at /campaign/<slug>' },
    { ...localeField, group: 'content' },
    defineField({
      name: 'campaignId',
      title: 'Campaign id',
      type: 'string',
      description:
        'The marketing campaign this landing page belongs to (Admin → Marketing → Campaigns). Reporting joins on it.',
      group: 'content',
      validation: (rule) => rule.max(64),
    }),
    defineField({
      name: 'hero',
      title: 'Hero',
      type: 'hero',
      group: 'content',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'blocks',
      title: 'Blocks',
      type: 'array',
      of: pageBlocks,
      group: 'content',
    }),
    defineField({
      name: 'startsAt',
      title: 'Starts at',
      type: 'datetime',
      description: 'Before this the page answers 404',
      group: 'content',
    }),
    defineField({
      name: 'endsAt',
      title: 'Ends at',
      type: 'datetime',
      description: 'After this the page answers 404',
      group: 'content',
      validation: (rule) => rule.custom(endsAfterStart),
    }),
    seoField,
  ],
  preview: { select: { title: 'title', subtitle: 'campaignId' } },
});

export const navigation = defineType({
  name: 'navigation',
  title: 'Navigation',
  type: 'document',
  fields: [
    defineField({
      name: 'key',
      title: 'Menu',
      type: 'string',
      options: {
        list: [
          { title: 'Main menu', value: 'main' },
          { title: 'Utility menu', value: 'utility' },
        ],
      },
      initialValue: 'main',
      validation: (rule) => rule.required().custom(uniqueLocaleKey),
    }),
    localeField,
    defineField({
      name: 'items',
      title: 'Items',
      type: 'array',
      of: [defineArrayMember({ type: 'navItem' })],
      validation: (rule) => rule.required().min(1).max(8),
    }),
  ],
  preview: { select: { title: 'key', subtitle: 'locale' } },
});

export const footer = defineType({
  name: 'footer',
  title: 'Footer',
  type: 'document',
  fields: [
    defineField({
      ...localeField,
      description: 'The storefront language; one footer per language',
      validation: (rule) =>
        rule
          .required()
          .regex(LOCALE_PATTERN, { name: 'BCP-47 locale (xx-YY)' })
          .custom(uniqueLocale),
    }),
    defineField({
      name: 'columns',
      title: 'Link columns',
      type: 'array',
      of: [defineArrayMember({ type: 'footerColumn' })],
      validation: (rule) => rule.max(4),
    }),
    defineField({
      name: 'legalLinks',
      title: 'Legal links',
      type: 'array',
      of: [defineArrayMember({ type: 'link' })],
      validation: (rule) => rule.max(6),
    }),
    defineField({
      name: 'socialLinks',
      title: 'Social links',
      type: 'array',
      of: [defineArrayMember({ type: 'link' })],
      validation: (rule) => rule.max(6),
    }),
    defineField({
      name: 'copyright',
      title: 'Copyright line',
      type: 'string',
      validation: (rule) => rule.max(120),
    }),
  ],
  preview: { select: { subtitle: 'locale' }, prepare: (s) => ({ title: 'Footer', ...s }) },
});

export const LEGAL_KINDS = ['terms', 'privacy', 'imprint', 'cookies', 'returns'] as const;

export const legal = defineType({
  name: 'legal',
  title: 'Legal page',
  type: 'document',
  groups: contentGroups,
  fields: [
    { ...titleField, group: 'content' },
    { ...slugField, group: 'content' },
    { ...localeField, group: 'content' },
    defineField({
      name: 'kind',
      title: 'Kind',
      type: 'string',
      options: { list: LEGAL_KINDS.map((kind) => ({ title: kind, value: kind })) },
      group: 'content',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'body',
      title: 'Body',
      type: 'richText',
      group: 'content',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'lastReviewed',
      title: 'Last reviewed',
      type: 'date',
      description: 'Shown on the page; legal asks for it',
      group: 'content',
      validation: (rule) => rule.required(),
    }),
    seoField,
  ],
  preview: { select: { title: 'title', subtitle: 'kind' } },
});

export const documentTypes = [page, campaignLanding, navigation, footer, legal];
