import { Badge } from '@/components/ui/badge';
import type { AdminComponents } from '@/lib/api/admin-client';
import { lastLiveKeyId } from '@/lib/settings';
import { MakePrimaryButton, RevokeKeyButton } from './row-actions';

type Domain = AdminComponents['Domain'];
type SalesChannel = AdminComponents['SalesChannel'];
type ApiKey = AdminComponents['ApiKey'];

/**
 * The registry's lists, rendered on the server for both the HQ store page and the Store view's
 * settings. The records stay here; the client forms and row buttons take ids and names only. The
 * row buttons appear only when a `storeId` and the matching permission are passed (the Store view).
 */

export function DomainList({
  domains,
  storeId,
  canMovePrimary = false,
}: {
  domains: readonly Domain[];
  storeId?: string;
  canMovePrimary?: boolean;
}) {
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
          {canMovePrimary && storeId !== undefined && !domain.is_primary && (
            <span className="ml-auto">
              <MakePrimaryButton
                storeId={storeId}
                domainId={domain.id}
                hostname={domain.hostname}
              />
            </span>
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

/**
 * Keys by name and prefix only: the value is never recoverable after creation. With `canRevoke`,
 * each live key gets Revoke — except the store's last live publishable key, which `revokeApiKey`
 * refuses (409 `last_live_key`); that row says why instead of offering a button that cannot work.
 */
export function ApiKeyList({
  keys,
  channels,
  storeId,
  canRevoke = false,
}: {
  keys: readonly ApiKey[];
  channels: readonly SalesChannel[];
  storeId?: string;
  canRevoke?: boolean;
}) {
  if (keys.length === 0) return <p className="text-muted text-sm">No API keys yet.</p>;
  const channelName = new Map(channels.map((channel) => [channel.id, channel.name]));
  const lastLive = lastLiveKeyId(keys);
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
          {canRevoke &&
            storeId !== undefined &&
            key.revoked_at === null &&
            (key.id === lastLive ? (
              <span className="text-muted ml-auto text-xs" data-testid="last-live-key">
                Last live publishable key — create another before revoking this one.
              </span>
            ) : (
              <span className="ml-auto">
                <RevokeKeyButton storeId={storeId} keyId={key.id} name={key.name} />
              </span>
            ))}
        </li>
      ))}
    </ul>
  );
}
