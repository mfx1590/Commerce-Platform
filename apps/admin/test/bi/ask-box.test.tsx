/**
 * BI Q&A's Ask box (#606): asks through its route handler, shows the answer, the chart hint and every query as
 * editable JSON that runs through queryMetrics (no AI), sends thumbs to the server, and says what each refusal means.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { askErrorText, AskBox } from '@/app/(hq)/bi/_components/ask-box';
import type { MetricAnswer } from '@/app/(hq)/bi/_lib/metrics';

const A = '00000000-0000-4000-8000-000000000031';
const CONV = '00000000-0000-4000-8000-00000000c606';

const answer = (extra: Partial<MetricAnswer> = {}): MetricAnswer => ({
  conversation_id: CONV,
  answer: 'Bookings were €123.00 [q1].',
  queries: [
    {
      query: {
        metrics: ['bookings_minor'],
        dimensions: ['store'],
        grain: 'day',
        from: '2026-10-01',
        to: '2026-10-03',
        limit: 1000,
      },
      result: {
        query: {
          metrics: ['bookings_minor'],
          dimensions: ['store'],
          grain: 'day',
          from: '2026-10-01',
          to: '2026-10-03',
          limit: 1000,
        },
        generated_at: '2026-10-03T00:00:00Z',
        data_as_of: null,
        truncated: false,
        rows: [
          {
            period: '2026-10-01',
            currency: 'EUR',
            store_id: A,
            product_id: null,
            refund_reason: null,
            provider: null,
            values: { bookings_minor: 12_300 },
          },
        ],
        currency_totals: [{ currency: 'EUR', values: { bookings_minor: 12_300 } }],
      },
    },
    {
      query: {
        metrics: ['captured_minor'],
        dimensions: [],
        grain: 'total',
        from: '2026-10-01',
        to: '2026-10-03',
        limit: 1000,
      },
      error: { code: 'forbidden', message: 'captured_minor requires finance on organization:hq' },
    },
  ],
  chart: { query_index: 0, metric: 'bookings_minor' },
  excluded_store_ids: [],
  model: 'claude-sonnet-5-5',
  template: { id: 'bi-qa-answer', version: 1 },
  created_at: '2026-10-03T00:00:00Z',
  ...extra,
});

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

const reply = (status: number, body: unknown) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status });

async function askIt(question = 'bookings per day?') {
  render(<AskBox base="/bi" labels={{ [A]: 'brand-a' }} />);
  fireEvent.change(screen.getByLabelText('Question'), { target: { value: question } });
  fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
}

describe('AskBox', () => {
  it('asks its route handler and shows the answer, the chart, the editable query and the refused one', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, answer()));
    await askIt();
    expect(await screen.findByText('Bookings were €123.00 [q1].')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      '/bi/ask',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ question: 'bookings per day?' }),
      }),
    );
    expect(screen.getByRole('img', { name: /bookings_minor \(EUR\)/ })).toBeTruthy();
    expect((screen.getByLabelText('Query q1') as HTMLTextAreaElement).value).toContain(
      '"bookings_minor"',
    );
    expect(screen.getByText(/q2: refused — captured_minor requires finance/)).toBeTruthy();
  });

  it('an edited query runs as is through the query handler (no AI) and shows its totals', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, answer()));
    await askIt();
    const box = (await screen.findByLabelText('Query q1')) as HTMLTextAreaElement;
    const edited = { ...JSON.parse(box.value), grain: 'total' };
    fireEvent.change(box, { target: { value: JSON.stringify(edited) } });
    fetchMock.mockResolvedValueOnce(
      reply(200, {
        ...answer().queries[0]!.result!,
        currency_totals: [{ currency: 'EUR', values: { bookings_minor: 99 } }],
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByTestId('ask-query-result-0')).toHaveProperty(
      'textContent',
      'EUR: bookings_minor 99',
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/bi/query',
      expect.objectContaining({ body: JSON.stringify(edited) }),
    );
  });

  it('thumbs go to the conversation’s feedback handler', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, answer()));
    await askIt();
    await screen.findByTestId('ask-answer');
    fetchMock.mockResolvedValueOnce(reply(204, null));
    fireEvent.click(screen.getByRole('button', { name: '👍' }));
    await waitFor(() => expect(screen.getByText('Thanks.')).toBeTruthy());
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/bi/ask/${CONV}/feedback`,
      expect.objectContaining({ body: JSON.stringify({ rating: 'up' }) }),
    );
  });

  it('a refusal is a plain sentence, never a partial answer', async () => {
    fetchMock.mockResolvedValueOnce(
      reply(403, { code: 'forbidden', details: { reason: 'bi_qa_off' } }),
    );
    await askIt();
    expect((await screen.findByRole('alert')).textContent).toBe(
      'BI Q&A is switched off for this store.',
    );
    expect(screen.queryByTestId('ask-answer')).toBeNull();
  });
});

describe('askErrorText', () => {
  it.each([
    [403, { code: 'forbidden', details: { reason: 'bi_qa_off' } }, 'switched off'],
    [403, { code: 'forbidden' }, 'stores you may see'],
    [429, { code: 'ai_rate_limited' }, 'Try again in a minute'],
    [422, { code: 'ai_tool_limit' }, 'narrower question'],
    [422, { code: 'ai_refused' }, 'Reword'],
    [503, { code: 'ai_disabled' }, 'not available'],
  ])('%i %o', (status, body, text) => {
    expect(askErrorText(status, body)).toContain(text);
  });
});
