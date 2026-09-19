/**
 * The documents as the storefront's fetch layer (task 2.2) receives them. Hand-written to mirror
 * `schema/*.ts`; `test/fixtures.test.ts` keeps them honest by validating typed fixtures against
 * the schemas.
 */

import type { Locale } from './datasets.js';
import type { LEGAL_KINDS } from './schema/documents.js';
import type { EmbedProvider } from './schema/embed.js';

export interface SanityReference {
  _type: 'reference';
  _ref: string;
  _weak?: boolean;
}

export interface SanityImage {
  _type: 'image';
  /** Absent when the image is served from Cloudinary instead of a Sanity upload. */
  asset?: SanityReference;
  /** Cloudinary delivery URL; when set it wins over the Sanity asset (task 2.5). */
  cloudinaryUrl?: string;
  alt: string;
  hotspot?: { x: number; y: number; height: number; width: number };
  crop?: { top: number; bottom: number; left: number; right: number };
}

export interface PortableTextSpan {
  _type: 'span';
  _key: string;
  text: string;
  marks?: string[];
}

export interface PortableTextBlock {
  _type: 'block';
  _key: string;
  style?: 'normal' | 'h2' | 'h3' | 'blockquote';
  listItem?: 'bullet' | 'number';
  level?: number;
  children: PortableTextSpan[];
  markDefs?: { _key: string; _type: 'link'; href: string }[];
}

export type RichTextContent = (PortableTextBlock | (SanityImage & { _key: string }))[];

export interface Link {
  _type: 'link';
  _key?: string;
  label: string;
  href: string;
  openInNewTab?: boolean;
}

export interface Cta {
  _type: 'cta';
  _key?: string;
  label: string;
  href: string;
  variant: 'primary' | 'secondary';
}

export interface Seo {
  _type?: 'seo';
  metaTitle?: string;
  metaDescription?: string;
  ogImage?: SanityImage;
  noIndex?: boolean;
}

export interface Hero {
  _type: 'hero';
  _key?: string;
  eyebrow?: string;
  headline: string;
  subheadline?: string;
  image?: SanityImage;
  ctas?: Cta[];
  layout?: 'image-right' | 'image-left' | 'full-bleed';
}

export interface RichTextBlock {
  _type: 'richText';
  _key?: string;
  content: RichTextContent;
}

export interface ImageBlock {
  _type: 'imageBlock';
  _key?: string;
  image: SanityImage;
  caption?: string;
  width?: 'content' | 'wide';
}

export interface ProductStoryBlock {
  _type: 'productStory';
  _key?: string;
  productHandle: string;
  headline: string;
  body?: PortableTextBlock[];
  image?: SanityImage;
  cta?: Cta;
}

export type PageBlock = Hero | RichTextBlock | ImageBlock | ProductStoryBlock | Cta;

/** A sandboxed iframe on a campaign landing: a provider page by URL, or a pasted HTML snippet. */
export interface EmbedBlock {
  _type: 'embed';
  _key?: string;
  provider: EmbedProvider;
  title: string;
  url?: string;
  html?: string;
  height?: number;
}

export type CampaignBlock = PageBlock | EmbedBlock;

export interface NavItem {
  _type: 'navItem';
  _key?: string;
  label: string;
  href: string;
  children?: Link[];
}

export interface FooterColumn {
  _type: 'footerColumn';
  _key?: string;
  heading: string;
  links: Link[];
}

export const DOCUMENT_TYPES = ['page', 'campaignLanding', 'navigation', 'footer', 'legal'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

interface DocumentBase<T extends DocumentType> {
  _id: string;
  _type: T;
  locale: Locale;
  _createdAt?: string;
  _updatedAt?: string;
  _rev?: string;
}

export interface Slug {
  _type: 'slug';
  current: string;
}

export interface PageDocument extends DocumentBase<'page'> {
  title: string;
  slug: Slug;
  hero?: Hero;
  blocks?: PageBlock[];
  seo?: Seo;
}

export interface CampaignLandingDocument extends DocumentBase<'campaignLanding'> {
  title: string;
  slug: Slug;
  campaignId?: string;
  hero: Hero;
  blocks?: CampaignBlock[];
  startsAt?: string;
  endsAt?: string;
  seo?: Seo;
}

export interface NavigationDocument extends DocumentBase<'navigation'> {
  key: 'main' | 'utility';
  items: NavItem[];
}

export interface FooterDocument extends DocumentBase<'footer'> {
  columns?: FooterColumn[];
  legalLinks?: Link[];
  socialLinks?: Link[];
  copyright?: string;
}

export type LegalKind = (typeof LEGAL_KINDS)[number];

export interface LegalDocument extends DocumentBase<'legal'> {
  title: string;
  slug: Slug;
  kind: LegalKind;
  body: RichTextBlock;
  lastReviewed: string;
  seo?: Seo;
}

export type CmsDocument =
  PageDocument | CampaignLandingDocument | NavigationDocument | FooterDocument | LegalDocument;

/**
 * Deterministic ids: `<type>.<locale>.<slug-or-key>`. The seed script can re-run without
 * duplicating documents, and a translation of a page is the same id with another locale.
 */
export function documentId(type: DocumentType, locale: string, slugOrKey: string): string {
  return `${type}.${locale}.${slugOrKey}`;
}
