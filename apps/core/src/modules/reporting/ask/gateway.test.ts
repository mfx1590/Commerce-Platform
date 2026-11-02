// BI Q&A through the REAL AI gateway (packages/ai `createAiGateway`, #669) over its scripted fake transport: what the
// model is sent, what is audited per step, the store vs organization scope, the kill switch and the loop cap — the
// production path of askMetrics, with only the provider replaced.
import {
  createAiGateway,
  createFakeTransport,
  createMemoryAuditSink,
  createMemoryLimiter,
  type FakeScriptStep,
  type MemoryAuditSink,
} from '@platform/ai';
import { describe, expect, it } from 'vitest';
import type { MetricsReader } from '../metrics/execute';
import { askMetrics, type AskCaller } from './ask';
import type { GatewayFactory } from './gateway';

const ORG = '00000000-0000-4000-8000-000000000001';
const A = { id: '00000000-0000-4000-8000-000000000031', code: 'brand-a' };
const B = { id: '00000000-0000-4000-8000-000000000032', code: 'brand-b' };
const ACTOR = '00000000-0000-4000-8000-0000000000a1';

const seen: unknown[] = [];
const reader: MetricsReader = {
  async query({ query, query_params }) {
    if (query.includes('FROM raw_events')) return { json: async <T>() => [{ t: null }] as T[] };
    seen.push(query_params?.scope);
    const rows = ((query_params?.scope as string[]) ?? []).map((s) => ({
      out_period: '2026-10-01',
      out_currency: 'EUR',
      out_store: s,
      m_bookings_minor: 12_300,
    }));
    return { json: async <T>() => rows as T[] };
  },
};

const q = (extra: Record<string, unknown> = {}) => ({
  metrics: ['bookings_minor'],
  dimensions: ['store'],
  grain: 'total',
  from: '2026-10-01',
  to: '2026-11-01',
  ...extra,
});

function real(script: FakeScriptStep[], env: NodeJS.ProcessEnv = { AI_ENABLED: '1' }) {
  const transport = createFakeTransport({ script });
  const audit: MemoryAuditSink = createMemoryAuditSink();
  const limiter = createMemoryLimiter();
  const gatewayFor: GatewayFactory = (scope) =>
    createAiGateway({ ...scope, purpose: 'analysis', transport, limiter, audit, env });
  return { transport, audit, gatewayFor };
}

const caller = (stores: AskCaller['stores'], organizationScope: boolean): AskCaller => ({
  organizationId: ORG,
  actorId: ACTOR,
  stores,
  finance: false,
  organizationScope,
});

const ask = (gatewayFor: GatewayFactory, c: AskCaller, question = 'bookings in October?') =>
  askMetrics({ reader, gatewayFor, biQaSwitches: async () => new Map() }, c, { question });

describe('askMetrics on the real gateway (packages/ai, fake transport)', () => {
  it('a store question: one audit row per step on the store, the same conversation, the tool names, no content', async () => {
    const { transport, audit, gatewayFor } = real([
      { toolUse: [{ name: 'query_metrics', input: q() }] },
      { text: 'Bookings were €123.00 [q1].' },
    ]);
    const r = await ask(gatewayFor, caller([A], false));
    expect(r.answer).toBe('Bookings were €123.00 [q1].');
    expect(r.template).toEqual({ id: 'bi-qa-answer', version: 1 });
    expect(
      audit.records.map((x) => [x.storeId, x.purpose, x.step, x.toolNames, x.outcome]),
    ).toEqual([
      [A.id, 'analysis', 0, ['query_metrics'], 'ok'],
      [A.id, 'analysis', 1, [], 'ok'],
    ]);
    expect(new Set(audit.records.map((x) => x.conversationId))).toEqual(
      new Set([r.conversation_id]),
    );
    expect(audit.records.every((x) => x.actorId === ACTOR && x.organizationId === ORG)).toBe(true);
    // the model got the one narrowed tool and the store, and the tool result came back to it
    expect(transport.calls[0]!.tools!.map((t) => t.name)).toEqual(['query_metrics']);
    expect(transport.calls[0]!.user).toContain('brand-a');
    expect(transport.calls[0]!.user).not.toContain('brand-b');
    // the tool's schema carries the real store ids (the enum the model must pick from); the prompt text is redacted,
    // (a uuid passes packages/ai's redaction whole since #681: see the stores-line test below)
    const schema = JSON.stringify(transport.calls[0]!.tools![0]!.inputSchema);
    expect(schema).toContain(A.id);
    expect(schema).not.toContain(B.id);
    const back = transport.calls[1]!.turns!.find((t) => t.role === 'user') as {
      toolResults: { content: string; isError: boolean }[];
    };
    expect(back.toolResults[0]!.isError).toBe(false);
    expect(JSON.parse(back.toolResults[0]!.content)).toMatchObject({ ref: 'q1' });
  });

  it('products reach the model as p1, p2 … with no product_id (#680 review); the caller keeps the ids', async () => {
    const P1 = '00000000-0000-4000-8000-0000000000f1';
    const P2 = '00000000-0000-4000-8000-0000000000f2';
    const byProduct: MetricsReader = {
      async query({ query }) {
        if (query.includes('FROM raw_events')) return { json: async <T>() => [{ t: null }] as T[] };
        const rows = [P2, P1].map((p, i) => ({
          out_period: '2026-10-01',
          out_product: p,
          m_units: i + 1,
        }));
        return { json: async <T>() => rows as T[] };
      },
    };
    const { transport, gatewayFor } = real([
      {
        toolUse: [
          { name: 'query_metrics', input: q({ metrics: ['units'], dimensions: ['product'] }) },
        ],
      },
      { text: 'ok' },
    ]);
    const r = await askMetrics(
      { reader: byProduct, gatewayFor, biQaSwitches: async () => new Map() },
      caller([A], false),
      { question: 'top products?' },
    );
    const back = transport.calls[1]!.turns!.find((t) => t.role === 'user') as {
      toolResults: { content: string }[];
    };
    const sent = JSON.parse(back.toolResults[0]!.content) as { rows: Record<string, unknown>[] };
    expect(sent.rows.map((x) => x.product)).toEqual(['p1', 'p2']);
    expect(sent.rows.every((x) => !('product_id' in x))).toBe(true);
    expect(back.toolResults[0]!.content).not.toContain(P1);
    expect(r.queries[0]!.result!.rows.map((x) => x.product_id)).toEqual([P1, P2]); // sorted; p1 is the first row's
  });

  it('rows reach the model by store CODE (a uuid would be mangled by redaction); the caller keeps the ids', async () => {
    const digitHeavy = { id: '5a1b2c3d-1111-4222-8333-444455556666', code: 'brand-a' };
    const { transport, gatewayFor } = real([
      { toolUse: [{ name: 'query_metrics', input: q() }] },
      { text: 'ok' },
    ]);
    const r = await ask(gatewayFor, caller([digitHeavy], false));
    const back = transport.calls[1]!.turns!.find((t) => t.role === 'user') as {
      toolResults: { content: string }[];
    };
    const sent = JSON.parse(back.toolResults[0]!.content) as { rows: Record<string, unknown>[] };
    expect(sent.rows.map((x) => x.store)).toEqual(['brand-a']);
    expect(back.toolResults[0]!.content).not.toContain('[phone]');
    expect(r.queries[0]!.result!.rows.map((x) => x.store_id)).toEqual([digitHeavy.id]);
  });

  it('the stores line (code + id) reaches the model whole: no "[phone]", step 0 counts no redaction (#681)', async () => {
    const digitHeavy = { id: '5a1b2c3d-1111-4222-8333-444455556666', code: 'brand-a' };
    const { transport, audit, gatewayFor } = real([
      { toolUse: [{ name: 'query_metrics', input: q() }] },
      { text: 'ok' },
    ]);
    await ask(gatewayFor, caller([digitHeavy], false));
    const user = transport.calls[0]!.user;
    expect(user).toContain(`brand-a ${digitHeavy.id}`);
    expect(user).not.toContain('[phone]');
    expect(audit.records.find((x) => x.step === 0)).toMatchObject({ redactions: 0 });
  });

  it('an organization-level principal: the organization budget and audit (storeId null)', async () => {
    const { audit, gatewayFor } = real([{ text: 'Nothing to look up.' }]);
    await ask(gatewayFor, caller([A, B], true));
    expect(audit.records.map((x) => x.storeId)).toEqual([null]);
  });

  it('store B through the tool: an error result goes back to the model, nothing is read, no B data is sent', async () => {
    seen.length = 0;
    const { transport, gatewayFor } = real([
      { toolUse: [{ name: 'query_metrics', input: q({ filters: { store_ids: [B.id] } }) }] },
      { text: 'I cannot read that store.' },
    ]);
    const r = await ask(gatewayFor, caller([A], false), 'how did brand-b do?');
    expect(seen).toEqual([]);
    expect(r.queries[0]!.error).toMatchObject({ code: 'forbidden' });
    const back = transport.calls[1]!.turns!.find((t) => t.role === 'user') as {
      toolResults: { content: string; isError: boolean }[];
    };
    expect(back.toolResults[0]!.isError).toBe(true);
    expect(back.toolResults[0]!.content).not.toContain('12300');
  });

  it('the question is redacted before it is sent (an e-mail address never reaches the provider)', async () => {
    const { transport, gatewayFor } = real([{ text: 'ok' }]);
    await ask(gatewayFor, caller([A], false), 'bookings for jane.doe@example.com?');
    expect(transport.calls[0]!.user).not.toContain('jane.doe@example.com');
  });

  it('AI switched off: ai_disabled (503), the provider never called, the refusal audited', async () => {
    const { transport, audit, gatewayFor } = real([{ text: 'never' }], { AI_ENABLED: '0' });
    await expect(ask(gatewayFor, caller([A], false))).rejects.toMatchObject({
      code: 'ai_disabled',
      status: 503,
    });
    expect(transport.calls).toEqual([]);
    expect(audit.records.map((x) => x.outcome)).toEqual(['disabled']);
  });

  it('more tool calls than allowed: ai_tool_limit (422), audited as tool_loop_cap', async () => {
    const six = Array.from({ length: 6 }, () => ({ name: 'query_metrics', input: q() }));
    const { audit, gatewayFor } = real([{ toolUse: six }, { text: 'never' }]);
    await expect(ask(gatewayFor, caller([A], false))).rejects.toMatchObject({
      code: 'ai_tool_limit',
      status: 422,
    });
    expect(audit.records.at(-1)!.outcome).toBe('tool_loop_cap');
  });
});
