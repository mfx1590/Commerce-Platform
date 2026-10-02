import { Badge } from '@/components/ui/badge';
import type { AdminComponents } from '@/lib/api/admin-client';

type Domain = AdminComponents['Domain'];
type SalesChannel = AdminComponents['SalesChannel'];
type ApiKey = AdminComponents['ApiKey'];

/**
 * The registry's lists, rendered on the server for both the HQ store page and the Store view's
 * settings. The records stay here; the client forms beside them take ids and options only.
 */

export function DomainList({ domains }: { domains: readonly Domain[] }) {
  if (domains.length === 0) {
    return (
      <p className="text-muted text-sm">
        No domains yet. The storefront is not reachable until one is added and verified.
      </p>
    );
  }
  return (
    <ul className="divide-line divide-y text-sm" aria-label="Domains">
      {domains.map((domain) => (
        <li key={domain.id} className="flex flex-wrap items-center gap-3 py-2">
          <span className="font-mono text-xs">{domain.hostname}</span>
          {domain.is_primary && <Badge tone="accent">primary</Badge>}
          {domain.verified_at === null ? (
            <Badge tone="warning">unverified</Badge>
          ) : (
            <Badge tone="success">verified</Badge>
          )}
        </li>
      ))}
    </ul>
  );
}

export function SalesChannelList({ channels }: { channels: readonly SalesChannel[] }) {
  if (channels.length === 0) return <p className="text-muted text-sm">No sales channels yet.</p>;
  return (
    <ul className="divide-line divide-y text-sm" aria-label="Sales channels">
      {channels.map((channel) => (
        <li key={channel.id} className="flex flex-wrap items-center gap-3 py-2">
          <span className="font-medium">{channel.name}</span>
          <span className="text-muted font-mono text-xs">{channel.code}</span>
          <Badge>{channel.type}</Badge>
          {!channel.is_active && <Badge tone="warning">inactive</Badge>}
        </li>
      ))}
    </ul>
  );
}

/** Keys by name and prefix only: the value is never recoverable after creation. */
export function ApiKeyList({
  keys,
  channels,
}: {
  keys: readonly ApiKey[];
  channels: readonly SalesChannel[];
}) {
  if (keys.length === 0) return <p className="text-muted text-sm">No API keys yet.</p>;
  const channelName = new Map(channels.map((channel) => [channel.id, channel.name]));
  return (
    <ul className="divide-line divide-y text-sm" aria-label="API keys">
      {keys.map((key) => (
        <li key={key.id} className="flex flex-wrap items-center gap-3 py-2">
          <span className="font-medium">{key.name}</span>
          <Badge tone={key.type === 'secret' ? 'warning' : 'neutral'}>{key.type}</Badge>
          <span className="text-muted font-mono text-xs">{key.key_prefix}…</span>
          {key.sales_channel_id !== null && (
            <span className="text-muted text-xs">
              {channelName.get(key.sales_channel_id) ?? key.sales_channel_id}
            </span>
          )}
          {key.revoked_at === null ? (
            <Badge tone="success">live</Badge>
          ) : (
            <Badge tone="danger">revoked</Badge>
          )}
        </li>
      ))}
    </ul>
  );
}
