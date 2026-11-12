import type { EmbedBlock } from '@platform/cms';
import { EMBED_HEIGHT, isAllowedEmbedUrl } from '@platform/cms';

/**
 * A campaign embed, always inside a sandboxed `<iframe>`; no third-party script ever runs in the
 * page itself.
 *
 * Sandbox flags differ by source on purpose:
 * - **Provider pages** (Builder.io / Framer, `src` on an allow-listed https host) get
 *   `allow-same-origin` alongside `allow-scripts`: the frame is cross-origin, so "same origin"
 *   is the provider's own origin, which their runtimes need for storage and API calls. They can
 *   never reach this page's DOM or cookies.
 * - **HTML snippets** (`srcdoc`) must NOT get `allow-same-origin`: a srcdoc frame inherits the
 *   parent's origin, and together with `allow-scripts` that would hand the snippet the whole
 *   page. Scripts stay enabled inside the sandboxed unique origin, where they can touch nothing
 *   of ours.
 *
 * The URL is re-checked against the provider allow-list at render (defence in depth, like
 * `safeHref`); a stored document that fails it renders nothing.
 */

export const PROVIDER_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups';
export const SRCDOC_SANDBOX = 'allow-scripts allow-forms allow-popups';

export function Embed({ block }: { block: EmbedBlock }) {
  const height = Math.min(
    Math.max(block.height ?? EMBED_HEIGHT.default, EMBED_HEIGHT.min),
    EMBED_HEIGHT.max,
  );
  const shared = {
    title: block.title,
    height,
    className: 'w-full rounded-lg border border-border',
    loading: 'lazy',
    referrerPolicy: 'strict-origin-when-cross-origin',
    allow: '',
  } as const;

  if (block.provider === 'html') {
    if (!block.html?.trim()) return null;
    return <iframe {...shared} sandbox={SRCDOC_SANDBOX} srcDoc={block.html} />;
  }
  if (!isAllowedEmbedUrl(block.provider, block.url)) return null;
  return <iframe {...shared} sandbox={PROVIDER_SANDBOX} src={block.url} />;
}
