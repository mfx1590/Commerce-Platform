/**
 * CMS rendering components. The `(content)` routes use them directly; window 3 mounts
 * `HomeContent`, `CmsHeader` and `CmsFooter` in the shop chrome in wave C (REQUEST #178).
 */
export { Blocks } from './blocks';
export { Embed, PROVIDER_SANDBOX, SRCDOC_SANDBOX } from './embed';
export { CmsFooter, type CmsFooterProps } from './footer';
export { CtaLink, Hero, type HeroProps } from './hero';
export { HOME_SLUG, HomeContent } from './home-content';
export {
  CmsHeader,
  navigationItems,
  staticNavigation,
  type CmsHeaderProps,
  type NavItemView,
} from './navigation';
export { PortableText } from './portable-text';
export { SafeLink } from './safe-link';
export { PreviewBanner } from './preview-banner';
export { ProductStory, type ProductStoryProps } from './product-story';
export {
  IMAGE_WIDTHS,
  SanityImage,
  parseAssetRef,
  sanityImageUrl,
  type AssetRef,
} from './sanity-image';
