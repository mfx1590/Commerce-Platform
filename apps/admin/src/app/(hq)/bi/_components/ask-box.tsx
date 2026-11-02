'use client';

/**
 * BI Q&A (#606): ask a question in words; the server answers with AI tool use over the metrics API (no SQL, the
 * caller's stores only) and returns every query it ran. The answer cites them as [q1], [q2] …; each query is shown
 * as editable JSON and "Run" sends it to `queryMetrics` as is (no AI). Thumbs up/down go to the server (the asker
 * only). Tokens stay on the server: everything goes through the route handlers under `base`.
 */
import { useState } from 'react';
import { formatMoney } from '@/lib/forms/money';
import { daysOf, SERIES_COLORS } from '../_lib/report';
import {
  storeSeries,
  type MetricAnswer,
  type MetricQuery,
  type MetricResult,
} from '../_lib/metrics';
import { SeriesChart } from './series-chart';

interface ApiError {
  code?: string;
  message?: string;
  details?: { reason?: string };
}

/** What the user reads for each refusal: plain words, the next step, never a stack. */
export function askErrorText(status: number, e: ApiError): string {
  if (status === 403 && e.details?.reason === 'bi_qa_off')
    return 'BI Q&A is switched off for this store.';
  if (status === 403) return 'You can only ask about the stores you may see.';
  if (status === 429) return 'Too many questions right now. Try again in a minute.';
  if (e.code === 'ai_tool_limit')
    return 'That needs too many look-ups at once. Ask a narrower question.';
  if (e.code === 'ai_refused') return 'The assistant could not answer that. Reword the question.';
  if (status === 400) return e.message ?? 'The question was not accepted.';
  return 'BI Q&A is not available right now. Try again later.';
}

function AnswerChart({ answer, labels }: { answer: MetricAnswer; labels: Record<string, string> }) {
  if (!answer.chart) return null;
  const x = answer.queries[answer.chart.query_index];
  if (!x?.result) return null;
  const currency = x.result.currency_totals.find((t) => t.currency !== null)?.currency ?? null;
  const days = daysOf({ from: x.query.from, to: x.query.to });
  const series = storeSeries(x.result, answer.chart.metric, currency ?? '', days);
  if (series.length === 0) return null;
  const money = currency !== null;
  return (
    <SeriesChart
      title={`${answer.chart.metric}${currency ? ` (${currency})` : ''}`}
      days={days}
      // the dashboard's validated slots (dark surface); a store past the last slot is not drawn, as in the v1 charts
      series={series.slice(0, SERIES_COLORS.length).map((s, i) => ({
        id: s.storeId,
        label: labels[s.storeId] ?? s.storeId,
        color: SERIES_COLORS[i]!,
        values: s.values,
      }))}
      format={(v) => (money ? formatMoney(v, currency!) : String(v))}
    />
  );
}

function EditableQuery({
  base,
  index,
  initial,
}: {
  base: string;
  index: number;
  initial: MetricQuery;
}) {
  const [text, setText] = useState(() => JSON.stringify(initial, null, 2));
  const [out, setOut] = useState<string | null>(null);
  const run = async () => {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      setOut('Not valid JSON.');
      return;
    }
    const res = await fetch(`${base}/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as MetricResult & ApiError;
    setOut(
      res.ok
        ? data.currency_totals
            .map(
              (t) =>
                `${t.currency ?? '—'}: ${Object.entries(t.values)
                  .map(([k, v]) => `${k} ${v ?? '—'}`)
                  .join(', ')}`,
            )
            .join(' · ') || 'No rows.'
        : (data.message ?? `Refused (${res.status}).`),
    );
  };
  return (
    <details className="border-line rounded border px-3 py-2">
      <summary className="cursor-pointer font-mono text-xs">q{index + 1}</summary>
      <textarea
        aria-label={`Query q${index + 1}`}
        className="bg-surface mt-2 h-40 w-full font-mono text-xs"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <button type="button" className="text-accent mt-1 text-xs underline" onClick={run}>
        Run
      </button>
      {out !== null && (
        <p className="text-muted mt-1 font-mono text-xs" data-testid={`ask-query-result-${index}`}>
          {out}
        </p>
      )}
    </details>
  );
}

export function AskBox({ base, labels }: { base: string; labels: Record<string, string> }) {
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<MetricAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rated, setRated] = useState<'up' | 'down' | null>(null);

  const ask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (question.trim() === '' || busy) return;
    setBusy(true);
    setError(null);
    setAnswer(null);
    setRated(null);
    try {
      const res = await fetch(`${base}/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question }),
      });
      const data = (await res.json()) as MetricAnswer & ApiError;
      if (res.ok) setAnswer(data);
      else setError(askErrorText(res.status, data));
    } catch {
      setError(askErrorText(503, {}));
    } finally {
      setBusy(false);
    }
  };

  const rate = async (rating: 'up' | 'down') => {
    if (!answer) return;
    const res = await fetch(`${base}/ask/${answer.conversation_id}/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rating }),
    });
    if (res.ok) setRated(rating);
  };

  return (
    <section aria-label="Ask" className="space-y-3">
      <form onSubmit={ask} className="flex gap-2">
        <input
          aria-label="Question"
          className="border-line bg-surface flex-1 rounded border px-3 py-2 text-sm"
          maxLength={500}
          placeholder="Ask about these metrics, e.g. “refunds per day last week”"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <button
          type="submit"
          disabled={busy}
          className="border-line rounded border px-3 py-2 text-sm"
        >
          {busy ? 'Asking…' : 'Ask'}
        </button>
      </form>
      {error && (
        <p role="alert" className="text-sm text-amber-300">
          {error}
        </p>
      )}
      {answer && (
        <div className="space-y-3" data-testid="ask-answer">
          <p className="text-sm whitespace-pre-line">{answer.answer}</p>
          <AnswerChart answer={answer} labels={labels} />
          {answer.queries.length > 0 && (
            <div className="space-y-2">
              <p className="text-muted text-xs">
                The queries behind the answer (edit and run them yourself):
              </p>
              {answer.queries.map((x, i) =>
                x.error ? (
                  <p key={i} className="text-muted font-mono text-xs">
                    q{i + 1}: refused — {x.error.message}
                  </p>
                ) : (
                  <EditableQuery key={i} base={base} index={i} initial={x.query} />
                ),
              )}
            </div>
          )}
          {answer.excluded_store_ids.length > 0 && (
            <p className="text-muted text-xs">
              Not included (BI Q&A off):{' '}
              {answer.excluded_store_ids.map((id) => labels[id] ?? id).join(', ')}
            </p>
          )}
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted">Was this useful?</span>
            <button type="button" aria-pressed={rated === 'up'} onClick={() => rate('up')}>
              👍
            </button>
            <button type="button" aria-pressed={rated === 'down'} onClick={() => rate('down')}>
              👎
            </button>
            {rated && <span className="text-muted">Thanks.</span>}
          </div>
        </div>
      )}
    </section>
  );
}
