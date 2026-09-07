import type { Metadata } from 'next';
import { ComingSoon } from '@/components/coming-soon';

/**
 * Placeholder only. Window 6 (CMS) owns `(content)/**` and `src/lib/cms` and replaces this with
 * pages rendered from the brand's Sanity dataset (`store.content_space_id`).
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  return { title: slug };
}

export default async function ContentPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <ComingSoon title={`Content page: ${slug}`} task="window 6 (CMS)" />;
}
