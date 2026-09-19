/**
 * One fixture document per type, for Brand A in en-GB. They are the test data for the schema
 * validator, the storefront's rendering tests (task 2.3) and what `pnpm seed` pushes into a
 * dataset. Window 10 clones them per brand and locale (#141) — see README, "Adding a locale".
 *
 * Images point at `PLACEHOLDER_ASSET_REF`; the seed script uploads a real placeholder asset and
 * rewrites the reference, because Sanity refuses a document that references a missing asset.
 */

import { documentId } from '../types.js';
import type {
  CampaignLandingDocument,
  CmsDocument,
  DocumentType,
  FooterDocument,
  LegalDocument,
  NavigationDocument,
  PageDocument,
  PortableTextBlock,
  SanityImage,
} from '../types.js';

export const PLACEHOLDER_ASSET_REF = 'image-placeholder-1x1-png';

export const FIXTURE_LOCALE = 'en-GB';

function image(alt: string): SanityImage {
  return { _type: 'image', asset: { _type: 'reference', _ref: PLACEHOLDER_ASSET_REF }, alt };
}

function paragraph(key: string, text: string, style: PortableTextBlock['style'] = 'normal') {
  return {
    _type: 'block',
    _key: key,
    style,
    children: [{ _type: 'span', _key: `${key}-span`, text }],
  } satisfies PortableTextBlock;
}

export const pageFixture: PageDocument = {
  _id: documentId('page', FIXTURE_LOCALE, 'about'),
  _type: 'page',
  locale: FIXTURE_LOCALE,
  title: 'About Brand A',
  slug: { _type: 'slug', current: 'about' },
  hero: {
    _type: 'hero',
    eyebrow: 'Since 2026',
    headline: 'Made for the mountains, worn in the city',
    subheadline: 'Small runs, honest materials, repaired for life.',
    image: image('A hiker on a ridge at sunrise wearing a Brand A jacket'),
    ctas: [
      {
        _type: 'cta',
        _key: 'shop',
        label: 'Shop the range',
        href: '/products',
        variant: 'primary',
      },
    ],
    layout: 'image-right',
  },
  blocks: [
    {
      _type: 'richText',
      _key: 'intro',
      content: [
        paragraph('heading-craft', 'How we make things', 'h2'),
        paragraph(
          'para-guarantee',
          'Every Brand A piece is cut in our own workshop and guaranteed for ten years.',
        ),
      ],
    },
    {
      _type: 'imageBlock',
      _key: 'workshop',
      image: image('Two people sewing at a long wooden bench in the Brand A workshop'),
      caption: 'The workshop, spring 2026',
      width: 'wide',
    },
    {
      _type: 'productStory',
      _key: 'story',
      productHandle: 'alpine-backpack',
      headline: 'The pack that started it all',
      body: [paragraph('para-story', 'Thirty litres, one pocket, no fuss.')],
      image: image('The Alpine backpack on a granite boulder'),
      cta: {
        _type: 'cta',
        label: 'See the Alpine',
        href: '/products/alpine-backpack',
        variant: 'secondary',
      },
    },
    {
      _type: 'cta',
      _key: 'closing',
      label: 'Visit the shop',
      href: '/products',
      variant: 'primary',
    },
  ],
  seo: {
    metaTitle: 'About Brand A',
    metaDescription: 'Who makes Brand A, where, and why every piece is guaranteed for ten years.',
  },
};

export const campaignLandingFixture: CampaignLandingDocument = {
  _id: documentId('campaignLanding', FIXTURE_LOCALE, 'spring-sale'),
  _type: 'campaignLanding',
  locale: FIXTURE_LOCALE,
  title: 'Spring sale',
  slug: { _type: 'slug', current: 'spring-sale' },
  campaignId: 'spring-2026',
  hero: {
    _type: 'hero',
    eyebrow: 'Limited time',
    headline: 'Up to 30% off last season',
    image: image('Folded jackets in spring colours on a white shelf'),
    ctas: [
      {
        _type: 'cta',
        _key: 'shop',
        label: 'Shop the sale',
        href: '/products?sort=price_asc',
        variant: 'primary',
      },
    ],
    layout: 'full-bleed',
  },
  blocks: [
    {
      _type: 'productStory',
      _key: 'story',
      productHandle: 'alpine-backpack',
      headline: 'Our best seller, now less',
      cta: {
        _type: 'cta',
        label: 'Buy the Alpine',
        href: '/products/alpine-backpack',
        variant: 'primary',
      },
    },
    {
      _type: 'embed',
      _key: 'lookbook',
      provider: 'framer',
      title: 'Spring lookbook',
      url: 'https://spring-sale.framer.website/',
      height: 900,
    },
  ],
  startsAt: '2026-03-01T00:00:00.000Z',
  endsAt: '2026-04-30T23:59:59.000Z',
  seo: { metaTitle: 'Spring sale — Brand A', noIndex: true },
};

export const navigationFixture: NavigationDocument = {
  _id: documentId('navigation', FIXTURE_LOCALE, 'main'),
  _type: 'navigation',
  locale: FIXTURE_LOCALE,
  key: 'main',
  items: [
    { _type: 'navItem', _key: 'shop', label: 'Shop', href: '/products' },
    {
      _type: 'navItem',
      _key: 'bags',
      label: 'Bags',
      href: '/categories/bags',
      children: [
        { _type: 'link', _key: 'backpacks', label: 'Backpacks', href: '/categories/backpacks' },
        { _type: 'link', _key: 'totes', label: 'Totes', href: '/categories/totes' },
      ],
    },
    { _type: 'navItem', _key: 'about', label: 'About', href: '/pages/about' },
  ],
};

export const footerFixture: FooterDocument = {
  _id: documentId('footer', FIXTURE_LOCALE, 'default'),
  _type: 'footer',
  locale: FIXTURE_LOCALE,
  columns: [
    {
      _type: 'footerColumn',
      _key: 'shop',
      heading: 'Shop',
      links: [
        { _type: 'link', _key: 'all', label: 'All products', href: '/products' },
        { _type: 'link', _key: 'bags', label: 'Bags', href: '/categories/bags' },
      ],
    },
    {
      _type: 'footerColumn',
      _key: 'help',
      heading: 'Help',
      links: [{ _type: 'link', _key: 'returns', label: 'Returns', href: '/legal/returns' }],
    },
  ],
  legalLinks: [
    { _type: 'link', _key: 'privacy', label: 'Privacy', href: '/legal/privacy' },
    { _type: 'link', _key: 'terms', label: 'Terms', href: '/legal/terms' },
  ],
  socialLinks: [
    {
      _type: 'link',
      _key: 'ig',
      label: 'Instagram',
      href: 'https://instagram.com/brand-a',
      openInNewTab: true,
    },
  ],
  copyright: '© 2026 Brand A B.V.',
};

export const legalFixture: LegalDocument = {
  _id: documentId('legal', FIXTURE_LOCALE, 'privacy'),
  _type: 'legal',
  locale: FIXTURE_LOCALE,
  title: 'Privacy policy',
  slug: { _type: 'slug', current: 'privacy' },
  kind: 'privacy',
  body: {
    _type: 'richText',
    content: [
      paragraph('heading-collect', 'What we collect', 'h2'),
      paragraph(
        'para-collect',
        'Only what an order needs: your name, address and email. We never sell it.',
      ),
    ],
  },
  lastReviewed: '2026-09-01',
  seo: { metaDescription: 'How Brand A handles your personal data.' },
};

export const fixtures: Record<DocumentType, CmsDocument> = {
  page: pageFixture,
  campaignLanding: campaignLandingFixture,
  navigation: navigationFixture,
  footer: footerFixture,
  legal: legalFixture,
};

export const fixtureDocuments: readonly CmsDocument[] = Object.values(fixtures);
