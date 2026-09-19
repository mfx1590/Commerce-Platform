/**
 * The campaign-landing embed: a Builder.io or Framer page, or a raw HTML snippet, shown inside a
 * sandboxed iframe by the storefront. The schema decides what may be embedded; the storefront's
 * `Embed` component decides how (sandbox flags per provider) and re-checks the URL before render.
 */

import type { CustomValidator } from './define.js';
import { defineField, defineType } from './define.js';

export const EMBED_PROVIDERS = ['builder', 'framer', 'html'] as const;
export type EmbedProvider = (typeof EMBED_PROVIDERS)[number];

/** Hosts a provider embed may load from; `*.` allows exactly one subdomain label. */
export const EMBED_HOSTS: Record<Exclude<EmbedProvider, 'html'>, readonly string[]> = {
  builder: ['builder.io', 'cdn.builder.io', '*.builder.io'],
  framer: ['*.framer.app', '*.framer.website'],
};

export const EMBED_HTML_MAX_LENGTH = 20_000;
export const EMBED_HEIGHT = { min: 200, max: 4000, default: 800 } as const;

function hostMatches(host: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1); // ".framer.app"
    return host.endsWith(suffix) && host.slice(0, -suffix.length).split('.').length === 1;
  }
  return host === pattern;
}

/** `https://` and a host on the provider's allow-list, nothing else (no userinfo tricks either). */
export function isAllowedEmbedUrl(provider: EmbedProvider, url: string | undefined): boolean {
  if (provider === 'html' || !url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
  return EMBED_HOSTS[provider].some((pattern) => hostMatches(parsed.hostname, pattern));
}

/** Exactly the source the provider needs: a URL for builder/framer, markup for html. */
export const embedSource: CustomValidator = (value) => {
  const embed = (value ?? {}) as { provider?: EmbedProvider; url?: string; html?: string };
  if (!embed.provider) return true; // `required()` on the field reports this one
  if (embed.provider === 'html') {
    if (!embed.html?.trim()) return 'Paste the HTML snippet for an HTML embed';
    if (embed.url) return 'An HTML embed has no URL; remove it or switch the provider';
    return true;
  }
  if (embed.html?.trim()) return 'A Builder/Framer embed uses the URL, not pasted HTML';
  if (!embed.url) return `Enter the ${embed.provider} page URL`;
  if (!isAllowedEmbedUrl(embed.provider, embed.url)) {
    return `Must be an https:// URL on ${EMBED_HOSTS[embed.provider].join(', ')}`;
  }
  return true;
};

export const embed = defineType({
  name: 'embed',
  title: 'Embed (Builder.io / Framer / HTML)',
  type: 'object',
  fields: [
    defineField({
      name: 'provider',
      title: 'Provider',
      type: 'string',
      options: {
        list: [
          { title: 'Builder.io page', value: 'builder' },
          { title: 'Framer page', value: 'framer' },
          { title: 'HTML snippet', value: 'html' },
        ],
        layout: 'radio',
      },
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'title',
      title: 'Title',
      type: 'string',
      description: 'What the embed shows — read out by screen readers as the frame name',
      validation: (rule) => rule.required().max(120),
    }),
    defineField({
      name: 'url',
      title: 'Page URL',
      type: 'string',
      description: 'The published Builder.io or Framer page (https://…)',
      hidden: false,
    }),
    defineField({
      name: 'html',
      title: 'HTML snippet',
      type: 'text',
      rows: 10,
      description:
        'Static markup only. It runs in a sandbox with no access to the storefront, its cookies or its scripts; inline scripts are blocked by the storefront’s content security policy.',
      validation: (rule) => rule.max(EMBED_HTML_MAX_LENGTH),
    }),
    defineField({
      name: 'height',
      title: 'Height (px)',
      type: 'number',
      initialValue: EMBED_HEIGHT.default,
      validation: (rule) => rule.min(EMBED_HEIGHT.min).max(EMBED_HEIGHT.max),
    }),
  ],
  validation: (rule) => rule.custom(embedSource),
  preview: { select: { title: 'title', subtitle: 'provider' } },
});
