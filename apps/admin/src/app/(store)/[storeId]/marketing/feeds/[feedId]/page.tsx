import { StoreSectionGuard } from '@/components/shell/section-guard';
import { ApiStatePanel } from '@/components/states/state-panel';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { publishFeedAction } from '../../_actions';
import { getFeed, listFeedItems } from '../../_api';
import { MarketingNav } from '../../section-nav';
import { CHANNEL_LABEL, FEED_STATUS_TONE, RENDERABLE_CHANNELS } from '../feeds-table.config';
import { PublishControl } from './publish-control';

export const dynamic = 'force-dynamic';

/**
 * One feed: what it publishes, what it refuses to publish, and why.
 *
 * The errors list is the reason this page exists. A row that fails a channel's required-field check is kept
 * out of the file but **reported here with its product** — a feed that is quietly short by two items is the
 * thing nobody notices until a channel's own dashboard says so, days later.
 */
export default async function FeedDetailPage({
  params,
}: {
  params: Promise<{ storeId: string; feedId: string }>;
}) {
  const { storeId, feedId } = await params;
  const [result, items] = await Promise.all([
    getFeed(storeId, feedId),
    listFeedItems(storeId, feedId, { limit: 10 }),
  ]);

  if (!result.ok) {
    return (
      <StoreSectionGuard storeId={storeId} id="marketing">
        <div className="space-y-4">
          <MarketingNav storeId={storeId} active="feeds" />
          <ApiStatePanel
            status={result.status}
            error={result.error}
            what="feed"
            storeId={storeId}
            backHref={`/${storeId}/marketing/feeds`}
            backLabel="Back to feeds"
          />
        </div>
      </StoreSectionGuard>
    );
  }

  const feed = result.data;
  const publish = publishFeedAction.bind(null, storeId, feedId);

  return (
    <StoreSectionGuard storeId={storeId} id="marketing">
      <div className="space-y-4">
        <MarketingNav storeId={storeId} active="feeds" />

        <Card>
          <CardHeader
            title={feed.name}
            description={`${CHANNEL_LABEL[feed.channel] ?? feed.channel} · ${feed.locale} · ${feed.currency}`}
            action={<Badge tone={FEED_STATUS_TONE[feed.status] ?? 'neutral'}>{feed.status}</Badge>}
          />
          <CardBody className="space-y-4">
            <PublishControl
              renderable={RENDERABLE_CHANNELS.includes(feed.channel)}
              publish={publish}
            />

            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm md:grid-cols-3">
              <div>
                <dt className="text-muted text-xs uppercase">Items</dt>
                <dd className="font-mono tabular-nums">{feed.item_count}</dd>
              </div>
              <div>
                <dt className="text-muted text-xs uppercase">Last published</dt>
                <dd className="font-mono text-xs">
                  {feed.last_published_at === null ? 'never' : feed.last_published_at.slice(0, 16)}
                </dd>
              </div>
              <div className="col-span-2 md:col-span-1">
                <dt className="text-muted text-xs uppercase">URL</dt>
                <dd className="truncate font-mono text-xs">{feed.url ?? '—'}</dd>
              </div>
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Problems"
            description="Rows the channel would reject are reported here and kept out of the file — never dropped silently."
          />
          <CardBody>
            {feed.errors.length === 0 ? (
              <p className="text-muted text-sm">Nothing to report on the last publish.</p>
            ) : (
              <ul className="divide-line divide-y text-sm">
                {feed.errors.map((problem, index) => (
                  <li key={`${problem.code}-${problem.product_id ?? index}`} className="py-2">
                    <p className="font-mono text-xs">{problem.code}</p>
                    <p className="text-muted text-xs">{problem.message}</p>
                    {problem.product_id === null || problem.product_id === undefined ? null : (
                      <p className="text-muted font-mono text-xs">product {problem.product_id}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Items"
            description="The first rows this feed emits, computed from its filters and mapping right now."
          />
          <CardBody>
            {!items.ok ? (
              <ApiStatePanel
                status={items.status}
                error={items.error}
                what="feed items"
                storeId={storeId}
              />
            ) : items.data.items.length === 0 ? (
              <p className="text-muted text-sm">This feed matches no products yet.</p>
            ) : (
              <table className="w-full text-sm">
                <caption className="sr-only">Feed items</caption>
                <thead className="text-muted text-xs uppercase">
                  <tr className="border-line border-b">
                    <th className="py-2 text-left font-medium">SKU</th>
                    <th className="py-2 text-left font-medium">Title</th>
                    <th className="py-2 text-left font-medium">Availability</th>
                    <th className="py-2 text-right font-medium">Price</th>
                    <th className="py-2 text-left font-medium">Problems</th>
                  </tr>
                </thead>
                <tbody className="divide-line divide-y">
                  {items.data.items.map((item) => (
                    <tr key={item.id}>
                      <td className="py-2 font-mono text-xs">{item.sku}</td>
                      <td className="py-2">{item.title}</td>
                      <td className="py-2 text-xs">{item.availability.replace('_', ' ')}</td>
                      <td className="py-2 text-right font-mono tabular-nums">
                        {item.price.amount_minor} {item.price.currency}
                      </td>
                      <td className="py-2 font-mono text-xs">
                        {item.errors.length === 0 ? (
                          <span className="text-muted">—</span>
                        ) : (
                          <span className="text-warning">{item.errors.join(', ')}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardBody>
        </Card>
      </div>
    </StoreSectionGuard>
  );
}
