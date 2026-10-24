// The contract as the server reads it (#551): seven read operations, every one `finance` on `organization:hq`,
// 401 / 403 documented, and the route matcher's rules.
import { describe, expect, it } from 'vitest';
import { loadApiSpec, matchRoute } from './spec.js';

const spec = loadApiSpec();
const LE = '00000000-0000-4000-8000-000000000011';
const PO = '00000000-0000-4000-8000-00000000d001';

describe('accounting.yaml as loaded', () => {
  it('has the seven read operations, all finance on organization:hq, each documenting 401 and 403', () => {
    expect(spec.operations.map((o) => o.operationId).sort()).toEqual([
      'getErpSyncStatus',
      'getPayout',
      'getTrialBalance',
      'listJournalLines',
      'listLegalEntityBooks',
      'listParkedEvents',
      'listPayouts',
    ]);
    for (const op of spec.operations) {
      expect(op.method).toBe('get');
      expect(op.permission).toEqual({ relation: 'finance', object: 'organization:hq' });
    }
    const paths = spec.document.paths as Record<
      string,
      Record<string, { responses: Record<string, unknown> }>
    >;
    for (const methods of Object.values(paths))
      for (const op of Object.values(methods)) {
        expect(Object.keys(op.responses)).toContain('401');
        expect(Object.keys(op.responses)).toContain('403');
      }
    expect(
      spec.operations.find((o) => o.operationId === 'listJournalLines')!.queryParams.sort(),
    ).toEqual([
      'account_code',
      'currency',
      'erp',
      'from',
      'journal',
      'limit',
      'page',
      'reference_id',
      'reference_type',
      'source_event_id',
      'to',
    ]);
  });

  it('matches routes by template with uuid path parameters only; nothing else matches', () => {
    expect(matchRoute(spec, 'GET', '/accounting/v1/legal-entities')!.operation.operationId).toBe(
      'listLegalEntityBooks',
    );
    const tb = matchRoute(spec, 'GET', `/accounting/v1/legal-entities/${LE}/trial-balance/`);
    expect(tb!.operation.operationId).toBe('getTrialBalance');
    expect(tb!.params).toEqual({ legalEntityId: LE });
    const po = matchRoute(
      spec,
      'get',
      `/accounting/v1/legal-entities/${LE.toUpperCase()}/payouts/${PO}`,
    );
    expect(po!.operation.operationId).toBe('getPayout');
    expect(po!.params).toEqual({ legalEntityId: LE, payoutId: PO });
    expect(
      matchRoute(spec, 'GET', `/accounting/v1/legal-entities/${LE}/payouts/not-a-uuid`),
    ).toBeNull();
    expect(matchRoute(spec, 'GET', `/accounting/v1/legal-entities/${LE}`)).toBeNull();
    expect(matchRoute(spec, 'POST', '/accounting/v1/legal-entities')).toBeNull();
    expect(matchRoute(spec, 'GET', '/accounting/v2/legal-entities')).toBeNull();
    expect(matchRoute(spec, 'GET', '/health')).toBeNull();
  });
});
