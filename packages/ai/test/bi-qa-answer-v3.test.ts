// bi-qa-answer@3 (from window 12's second real-model run, manager 2026-11-02): v2 plus two rules, nothing else. Every
// number not copied from a result (a count difference, "N more") is in the derived form or left out (case #17 wrote
// "6 more orders" bare); stores are named by code, never by id. v2 stays as published; one run through runTools.
import { describe, expect, it } from 'vitest';
import {
  createAiGateway,
  createFakeTransport,
  createMemoryAuditSink,
  createMemoryLimiter,
  getTemplate,
  renderTemplate,
  type TemplateVariables,
} from '../src/index.js';

const KEY = 'bi-qa-answer@3';

const vars: TemplateVariables<typeof KEY> = {
  question: 'How many more orders did brand-a have than brand-b last week?',
  locale: 'en-GB',
  today: '2026-11-02',
  window: '2026-10-03..2026-11-03',
  stores:
    'brand-a 33000000-0000-4000-8000-000000000031\nbrand-b 33000000-0000-4000-8000-000000000032',
  currencyNote:
    'Amounts are integer minor units per currency; never add different currencies together.',
};

const EVERY_NUMBER =
  '- This holds for EVERY number in the answer that is not copied from a result, counts included: a count difference, "N more" or "N fewer", how many times as many. It is written as the ONE derived figure, or left out; a second such number is always left out. The figure stands directly before "(derived:", with nothing between them but a currency code, and the words follow the brackets: "12 (derived: 95 [q1] − 83 [q2]) more orders". A ratio is written as its number, never as a word such as twice or half: "1.98 (derived: 190 [q1] / 96 [q2]) times as many". A share is a ratio too (0.43), never a percentage that no result contains; a percentage change is two steps, so leave it out unless a result contains it.\n';
const STORE_BY_CODE =
  '- Name a store by its code as listed in <stores> (for example brand-a), never by its id.\n';

describe('bi-qa-answer@3', () => {
  it('analysis, 1200 tokens per step, effort medium; the same variables and user prompt as v2', () => {
    const t = getTemplate(KEY);
    const v2 = getTemplate('bi-qa-answer@2');
    expect(t).toMatchObject({
      id: 'bi-qa-answer',
      version: 3,
      purpose: 'analysis',
      maxTokens: 1200,
      effort: 'medium',
    });
    expect([...t.variableNames].sort()).toEqual([...v2.variableNames].sort());
    expect(renderTemplate(t, vars).user).toBe(renderTemplate(v2, vars).user);
  });

  it('is v2 plus exactly the two new rules: every v2 rule (top-N, derived form, language) is kept word for word', () => {
    const v3 = getTemplate(KEY).system;
    expect(v3).toContain(EVERY_NUMBER);
    expect(v3).toContain(STORE_BY_CODE);
    expect(v3.replace(EVERY_NUMBER, '').replace(STORE_BY_CODE, '')).toBe(
      getTemplate('bi-qa-answer@2').system,
    );
  });

  it('places the every-number rule right after the derived rule: ONE derived figure, a second left out', () => {
    const v3 = getTemplate(KEY).system;
    expect(v3).toContain(
      'check it once more before you write it.\n- This holds for EVERY number in the answer',
    );
    expect(v3).toContain(
      'It is written as the ONE derived figure, or left out; a second such number is always left out.',
    );
    expect(v3).toContain('never as a word such as twice or half');
    expect(v3).toContain(
      'A share is a ratio too (0.43), never a percentage that no result contains',
    );
  });

  it('every derived example has its figure directly before "(derived:" (only a currency between) and is right (#684 review)', () => {
    // the shape window 12's golden checker accepts (#683): figure [currency] (derived: a [qi] op b [qj])
    const shape =
      /"([\d.,]+)(?: [A-Z]{3})? \(derived: ([\d.,]+) \[q\d+\] ([−+/]) ([\d.,]+) \[q\d+\]\)/g;
    const n = (x: string) => Number(x.replace(/,/g, ''));
    const system = getTemplate(KEY).system;
    const examples = [...system.matchAll(shape)];
    // v2's difference and ratio examples, then v3's count and times-as-many examples
    expect(examples.map((m) => m[0])).toEqual([
      '"1,250.00 EUR (derived: 4,000.00 [q1] − 2,750.00 [q2])',
      '"0.43 (derived: 1,250 [q1] / 2,900 [q2])',
      '"12 (derived: 95 [q1] − 83 [q2])',
      '"1.98 (derived: 190 [q1] / 96 [q2])',
    ]);
    // every "(derived: a [q] op b [q])" in the prompt is one of these (the rule's own '"(derived:"' is not an example)
    expect(system.match(/\(derived: [\d.,]+ \[q/g)).toHaveLength(examples.length);
    for (const [, figure, a, op, b] of examples) {
      const value =
        op === '/'
          ? Math.round((n(a!) / n(b!)) * 100) / 100
          : op === '+'
            ? n(a!) + n(b!)
            : n(a!) - n(b!);
      expect(value, figure).toBe(n(figure!));
    }
  });

  it('v2 stays as published (#682): none of the v3 rules', () => {
    const v2 = getTemplate('bi-qa-answer@2').system;
    expect(v2).not.toContain('EVERY number');
    expect(v2).not.toContain('never by its id');
  });

  it('runs through runTools on a query the real tool accepts; audit rows carry version 3', async () => {
    const transport = createFakeTransport({
      script: [
        {
          toolUse: [
            {
              name: 'query_metrics',
              input: {
                metrics: ['orders'],
                dimensions: ['store'],
                grain: 'total',
                from: '2026-10-26',
                to: '2026-11-02',
              },
            },
          ],
        },
        { text: 'brand-a had 12 (derived: 95 [q1] − 83 [q1]) more orders than brand-b.' },
      ],
    });
    const audit = createMemoryAuditSink();
    const ai = createAiGateway({
      organizationId: '33000000-0000-4000-8000-000000000001',
      storeId: null,
      purpose: 'analysis',
      actorId: null,
      transport,
      limiter: createMemoryLimiter(),
      audit,
      env: { AI_ENABLED: '1' },
    });
    const run = await ai.runTools(KEY, vars, {
      tools: [
        {
          name: 'query_metrics',
          description: 'Runs one typed metric query.',
          inputSchema: { type: 'object' },
        },
      ],
      handle: async () => ({
        content: JSON.stringify({
          ref: 'q1',
          rows: [
            { store: 'brand-a', orders: 95 },
            { store: 'brand-b', orders: 83 },
          ],
        }),
      }),
    });
    expect(run.template).toEqual({ id: 'bi-qa-answer', version: 3 });
    expect(transport.calls[0]!.system).toContain(EVERY_NUMBER);
    expect(audit.records.map((r) => [r.step, r.templateVersion, r.outcome])).toEqual([
      [0, 3, 'ok'],
      [1, 3, 'ok'],
    ]);
  });
});
