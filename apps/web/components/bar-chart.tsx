// A bar chart as inline SVG (plan/dashboard.md Rule 3, D-098). No library:
// one <path> per bar, a baseline, labels, a hover title, a hidden table.
//
// The rules it follows are the dataviz skill's for a ONE-series chart:
//   * one axis, the baseline at zero, no second scale;
//   * thin bars with rounded tops anchored flat on the baseline, a 2px gap
//     between neighbours;
//   * labels are SELECTIVE: the peak and the last bar carry their value, the
//     rest answer on hover (<title>, the SVG tooltip) and in the table;
//   * text wears text tokens (the muted ink), never the series colour; the
//     one series colour is the tenant's accent (D-030), so a tenant's theme
//     colours its bars;
//   * a <table> under `visually-hidden` is the chart as rows, for a screen
//     reader and for anyone who wants the numbers.
// Nothing here computes a figure: the values arrive from the server and are
// only scaled to pixels.

export interface Bar {
  label: string;
  value: number;
}

export type BarUnit = 'count' | 'pesos' | 'percent';

/** 1234567 centavos → "₱12,345.67"; 38.3 → "38.3 %"; 14 → "14". Display only. */
function format(value: number, unit: BarUnit, currency: string): string {
  if (unit === 'pesos') return new Intl.NumberFormat('en-PH', { style: 'currency', currency }).format(value / 100);
  if (unit === 'percent') return `${value} %`;
  return String(value);
}

/** A bar as a path: flat on the baseline, rounded on top, never taller than the plot. */
function barPath(x: number, top: number, width: number, baseline: number, radius: number): string {
  const r = Math.min(radius, width / 2, Math.max(baseline - top, 0));
  if (baseline - top <= 0) return '';
  return `M${x},${baseline} V${top + r} Q${x},${top} ${x + r},${top} H${x + width - r} Q${x + width},${top} ${x + width},${top + r} V${baseline} Z`;
}

export function BarChart({
  title,
  bars,
  unit = 'count',
  currency = 'PHP',
  height = 120,
}: {
  /** names the series: the chart's accessible name and the table's caption */
  title: string;
  bars: Bar[];
  unit?: BarUnit;
  currency?: string;
  height?: number;
}) {
  const width = 320;
  const pad = { top: 18, right: 4, bottom: 18, left: 4 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const baseline = pad.top + plotH;
  const max = Math.max(0, ...bars.map((b) => b.value));
  const n = Math.max(bars.length, 1);
  const gap = 2;
  const slot = plotW / n;
  const barW = Math.max(slot - gap, 1);
  const peak = bars.reduce((best, b, i) => (b.value > (bars[best]?.value ?? -1) ? i : best), 0);
  const labelled = new Set(max > 0 ? [peak, bars.length - 1] : []);
  // Date labels are long; show the first, the last and every nth so they never collide.
  const every = Math.max(1, Math.ceil(bars.length / 6));

  return (
    <figure className="bar-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title} preserveAspectRatio="none">
        <title>{title}</title>
        <line className="bar-chart-baseline" x1={pad.left} x2={width - pad.right} y1={baseline} y2={baseline} />
        {bars.map((b, i) => {
          const x = pad.left + i * slot + gap / 2;
          const h = max > 0 ? (b.value / max) * plotH : 0;
          const top = baseline - h;
          return (
            <g key={`${b.label}-${i}`}>
              <path className="bar-chart-bar" d={barPath(x, top, barW, baseline, 4)}>
                <title>{`${b.label}: ${format(b.value, unit, currency)}`}</title>
              </path>
              {/* A hit target bigger than the bar: the whole column answers on hover. */}
              <rect className="bar-chart-hit" x={pad.left + i * slot} y={pad.top} width={slot} height={plotH}>
                <title>{`${b.label}: ${format(b.value, unit, currency)}`}</title>
              </rect>
              {labelled.has(i) && (
                <text className="bar-chart-value" x={x + barW / 2} y={top - 4} textAnchor="middle">
                  {format(b.value, unit, currency)}
                </text>
              )}
              {(i === 0 || i === bars.length - 1 || i % every === 0) && bars.length <= 40 && (
                <text className="bar-chart-label" x={x + barW / 2} y={baseline + 12} textAnchor="middle">
                  {b.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <table className="visually-hidden">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th>Period</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>
          {bars.map((b, i) => (
            <tr key={i}>
              <td>{b.label}</td>
              <td>{format(b.value, unit, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/** A two-value split as one stacked bar with both numbers written on it: web vs staff, confirmed vs the rest. */
export function SplitBar({ a, b, labelA, labelB }: { a: number; b: number; labelA: string; labelB: string }) {
  const total = a + b;
  const pa = total === 0 ? 50 : (a / total) * 100;
  return (
    <div className="split-bar" role="img" aria-label={`${labelA} ${a}, ${labelB} ${b}`}>
      <div className="split-bar-track">
        <div className="split-bar-a" style={{ width: `${pa}%` }} />
      </div>
      <div className="split-bar-legend">
        <span>
          <i className="split-bar-dot a" /> {labelA} <strong>{a}</strong>
        </span>
        <span>
          <i className="split-bar-dot b" /> {labelB} <strong>{b}</strong>
        </span>
      </div>
    </div>
  );
}
