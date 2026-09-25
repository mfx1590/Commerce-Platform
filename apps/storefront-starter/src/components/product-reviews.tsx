import { getTranslations } from 'next-intl/server';
import { sortNewestFirst, summarise, type Review } from '@/lib/reviews';

/**
 * The PDP review block (task 2.4).
 *
 * Renders **nothing** when there are no reviews — not an empty state. A "no reviews yet" panel on
 * every product of a new catalogue is an announcement that nobody has bought anything, and window 17
 * only starts collecting reviews in Phase 3.
 *
 * Accessibility, deliberately rather than incidentally:
 * - the rating is text (`4 out of 5`), not a row of glyphs, so a screen reader reads a rating rather
 *   than "star star star star"; the stars are decorative and `aria-hidden`;
 * - each review is an `<article>` in a list, so a screen reader can skip between them;
 * - the date is a `<time datetime>`, so it is machine-readable whatever the display format;
 * - the section is labelled by its own heading, so it appears in a landmark/heading outline.
 */
export async function ProductReviews({ reviews }: { reviews: Review[] }) {
  if (reviews.length === 0) return null;

  const t = await getTranslations('pdp.reviews');
  const { count, average } = summarise(reviews);

  return (
    <section aria-labelledby="reviews" className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h2 id="reviews" className="text-xl font-semibold">
          {t('title')}
        </h2>
        {average === null ? null : (
          <p className="text-sm text-muted-foreground">
            <Stars rating={average} />
            <span>{t('summary', { average, count })}</span>
          </p>
        )}
      </header>

      <ul className="flex flex-col gap-6">
        {sortNewestFirst(reviews).map((review) => (
          <li key={review.id}>
            <article className="flex flex-col gap-2 border-t border-border pt-4">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <p className="text-sm font-medium">
                  <Stars rating={review.rating} />
                  <span>{t('rating', { rating: review.rating })}</span>
                </p>
                <time dateTime={review.created_at} className="text-xs text-muted-foreground">
                  {review.created_at.slice(0, 10)}
                </time>
                {review.verified_purchase ? (
                  <span className="text-xs font-medium text-muted-foreground">{t('verified')}</span>
                ) : null}
              </div>
              {review.title === null ? null : <h3 className="font-medium">{review.title}</h3>}
              {review.body === null ? null : (
                <p className="whitespace-pre-line text-sm text-muted-foreground">{review.body}</p>
              )}
              {review.author === null ? null : (
                <p className="text-xs text-muted-foreground">{review.author}</p>
              )}
            </article>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Decorative only: the rating is stated in text next to it, so this is hidden from assistive tech. */
function Stars({ rating }: { rating: number }) {
  const filled = Math.round(rating);
  return (
    <span aria-hidden="true" className="mr-2 tracking-widest text-foreground">
      {'★'.repeat(filled)}
      {'☆'.repeat(Math.max(0, 5 - filled))}
    </span>
  );
}
