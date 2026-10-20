/**
 * A small server-rendered line chart for the BI section (#480). Local to bi/ (manager decision Q3): promoted to a
 * shared primitive only through a window 4 REQUEST if another section needs one.
 *
 * One chart = one currency and one measure, one y-axis from zero. Each store is a 2px line in its fixed colour slot,
 * a legend names every series and ≤ 4 series are also labelled at the line end, so identity is never colour alone.
 * Hovering a day shows the store, day and value (native SVG tooltips on a hit target wider than the mark); the same
 * numbers are in the table below the chart.
 */

export interface ChartSeries {
  id: string;
  label: string;
  color: string;
  values: number[];
}

const W = 720;
const H = 240;
const PAD = { top: 12, right: 72, bottom: 28, left: 72 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

/** A "nice" axis maximum and step (1, 2, 2.5, 5 × 10ⁿ) so the gridlines land on round values. */
export function niceScale(max: number, ticks = 4): { max: number; step: number } {
  if (max <= 0) return { max: ticks, step: 1 };
  const raw = max / ticks;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow;
  return { max: step * ticks, step };
}

export function SeriesChart({
  title,
  days,
  series,
  format,
}: {
  title: string;
  days: readonly string[];
  series: readonly ChartSeries[];
  format: (value: number) => string;
}) {
  const peak = Math.max(0, ...series.flatMap((s) => s.values));
  const { max, step } = niceScale(peak);
  const n = Math.max(days.length - 1, 1);
  const x = (i: number) => PAD.left + (i / n) * PLOT_W;
  const y = (v: number) => PAD.top + PLOT_H - (v / max) * PLOT_H;
  const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);
  const labelled = series.length <= 4;
  const xLabels = [0, Math.floor((days.length - 1) / 2), days.length - 1].filter(
    (i, k, all) => i >= 0 && all.indexOf(i) === k,
  );

  return (
    <figure className="space-y-3">
      <figcaption className="text-sm font-medium">{title}</figcaption>
      {series.length > 1 && (
        <ul className="flex flex-wrap gap-4 text-xs" aria-label="Legend">
          {series.map((s) => (
            <li key={s.id} className="flex items-center gap-2">
              <span
                aria-hidden
                className="inline-block h-0.5 w-4 rounded"
                style={{ backgroundColor: s.color }}
              />
              <span className="text-muted font-mono">{s.label}</span>
            </li>
          ))}
        </ul>
      )}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${title}: ${series.map((s) => s.label).join(', ')}`}
        className="text-muted h-auto w-full"
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(t)}
              y2={y(t)}
              stroke="var(--color-line)"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 8}
              y={y(t)}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize={11}
              fill="currentColor"
            >
              {format(t)}
            </text>
          </g>
        ))}
        {xLabels.map((i) => (
          <text
            key={days[i]}
            x={x(i)}
            y={H - 8}
            textAnchor={i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle'}
            fontSize={11}
            fill="currentColor"
          >
            {days[i]}
          </text>
        ))}
        {series.map((s) => {
          const points = s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
          const last = s.values.length - 1;
          return (
            <g key={s.id}>
              <polyline
                points={points}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {labelled && last >= 0 && (
                <text
                  x={x(last) + 6}
                  y={y(s.values[last] ?? 0)}
                  dominantBaseline="middle"
                  fontSize={11}
                  fill="var(--color-ink)"
                >
                  {s.label}
                </text>
              )}
              {s.values.map((v, i) => (
                <circle key={days[i]} cx={x(i)} cy={y(v)} r={7} fill="transparent">
                  <title>{`${s.label} · ${days[i]} · ${format(v)}`}</title>
                </circle>
              ))}
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
