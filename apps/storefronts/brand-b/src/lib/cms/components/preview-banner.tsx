import type { ContentContext } from '../content';

/** Shown only while the preview cookie is valid: editors must always know they are seeing drafts. */
export function PreviewBanner({ ctx, returnTo }: { ctx: ContentContext; returnTo: string }) {
  if (!ctx.preview) return null;
  const exit = `/api/cms/preview/exit?redirect=${encodeURIComponent(returnTo)}`;
  return (
    <div
      role="status"
      className="flex items-center justify-between gap-4 bg-amber-100 px-4 py-2 text-sm text-amber-900"
    >
      <span>{ctx.t('preview.banner')}</span>
      <a href={exit} className="font-medium underline">
        {ctx.t('preview.exit')}
      </a>
    </div>
  );
}
