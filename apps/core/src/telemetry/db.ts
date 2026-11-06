// The database span (#729): one `db.transaction` span around every transaction of a scoped client, which is the
// only way the core reaches Postgres (src/lib/db.ts). No SQL text and no parameters are recorded; a failure
// carries its SQLSTATE as `error.type`. Without active telemetry the client is returned unchanged.
import { SpanKind } from '@opentelemetry/api';
import type { Queryable, ScopedClient } from '@platform/db';
import { inSpan } from './context';
import { telemetryActive } from './sdk';

export function traceScopedClient(client: ScopedClient): ScopedClient {
  if (!telemetryActive()) return client;
  const attributes = {
    'db.system.name': 'postgresql',
    'db.operation.name': 'transaction',
    'core.db.scope': client.scope,
  };
  const transaction = <T>(fn: (tx: Queryable) => Promise<T>): Promise<T> =>
    inSpan('db.transaction', attributes, () => client.transaction(fn), SpanKind.CLIENT);
  return {
    scope: client.scope,
    context: client.context,
    transaction,
    query: (text, params) => transaction((tx) => tx.query(text, params)),
  };
}
