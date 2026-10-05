'use client';

// A bar chart as inline SVG (plan/dashboard.md Rule 3, D-098). No library:
// one <path> per bar, a baseline, labels, a readout, a hidden table.
//
// The rules it follows are the dataviz skill's for a ONE-series chart:
//   * one axis, the baseline at zero, no second scale;
//   * thin bars with rounded tops anchored flat on the baseline, a 2px gap
//     between neighbours;
//   * labels are SELECTIVE: the peak and the last bar carry their value, the
//     rest answer in the readout and in the table;
//   * text wears text tokens (the muted ink), never the series colour; the
//     one series colour is the tenant's accent (D-030), so a tenant's theme
//     colours its bars;
//   * a <table> under `visually-hidden` is the chart as rows, for a screen
//     reader and for anyone who wants the numbers.
// Nothing here computes a figure: the values arrive from the server and are
// only scaled to pixels.
//
// Since plan/ui-refresh.md Phase 6:
//   * the SVG is drawn at its real pixel width (a ResizeObserver), not
//     stretched with preserveAspectRatio="none", which widened every label;
//   * the readout is a real tooltip on hover, and the same on the keyboard:
//     the chart is one tab stop, the arrow keys step the bars, and a live
//     region says each one ("tooltips enhance, they never gate": the values
//     are also in the table).

import { useLayoutEffect, useRef, useState } from 'react';

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
  height = 140,
}: {
  /** names the series: the chart's accessible name and the table's caption */
  title: string;
  bars: Bar[];
  unit?: BarUnit;
  currency?: string;
  height?: number;
}) {
  const figure = useRef<HTMLElement>(null);
  // Drawn at the real width; 320 until the first measurement (and on the server).
  const [width, setWidth] = useState(320);
  const [active, setActive] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = figure.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(120, Math.round(el.clientWidth)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const pad = { top: 20, right: 4, bottom: 20, left: 4 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const baseline = pad.top + plotH;
  const max = Math.max(0, ...bars.map((b) => b.value));
  const n = Math.max(bars.length, 1);
  const gap = 2;
  const slot = plotW / n;
  // Thin marks: a bar never wider than 48px, centred in its slot.
  const barW = Math.min(Math.max(slot - gap, 1), 48);
  const xOf = (i: number) => pad.left + i * slot + (slot - barW) / 2;
  const peak = bars.reduce((best, b, i) => (b.value > (bars[best]?.value ?? -1) ? i : best), 0);
  const labelled = new Set(max > 0 ? [peak, bars.length - 1] : []);
  // Date labels are ~44px wide at 11px; space them so they never collide.
  const every = Math.max(1, Math.ceil(bars.length / Math.max(1, Math.floor(plotW / 56))));

  const indexAt = (clientX: number) => {
    const box = figure.current?.getBoundingClientRect();
    if (!box || bars.length === 0) return null;
    return Math.min(bars.length - 1, Math.max(0, Math.floor((clientX - box.left - pad.left) / slot)));
  };
  const shown = active !== null ? bars[active] : undefined;

  return (
    <figure className="bar-chart" ref={figure}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${title}. Use the arrow keys to read each bar.`}
        tabIndex={bars.length > 0 ? 0 : undefined}
        className={active !== null ? 'has-active' : undefined}
        onPointerMove={(event) => setActive(indexAt(event.clientX))}
        onPointerLeave={() => setActive(null)}
        onFocus={() => setActive((a) => a ?? bars.length - 1)}
        onBlur={() => setActive(null)}
        onKeyDown={(event) => {
          if (bars.length === 0) return;
          const now = active ?? bars.length - 1;
          const to =
            event.key === 'ArrowLeft' ? Math.max(0, now - 1)
            : event.key === 'ArrowRight' ? Math.min(bars.length - 1, now + 1)
            : event.key === 'Home' ? 0
            : event.key === 'End' ? bars.length - 1
            : null;
          if (to === null) return;
          event.preventDefault();
          setActive(to);
        }}
      >
        <line className="bar-chart-baseline" x1={pad.left} x2={width - pad.right} y1={baseline} y2={baseline} />
        {bars.map((b, i) => {
          const x = xOf(i);
          const h = max > 0 ? (b.value / max) * plotH : 0;
          const top = baseline - h;
          return (
            <g key={`${b.label}-${i}`} className={i === active ? 'bar-chart-active' : undefined}>
              <path className="bar-chart-bar" d={barPath(x, top, barW, baseline, 4)} />
              {labelled.has(i) && (
                <text className="bar-chart-value" x={x + barW / 2} y={top - 6} textAnchor="middle">
                  {format(b.value, unit, currency)}
                </text>
              )}
              {(i === 0 || i === bars.length - 1 || i % every === 0) && (
                <text className="bar-chart-label" x={x + barW / 2} y={baseline + 14} textAnchor="middle">
                  {b.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {shown && active !== null && (
        // Values lead, labels follow (dataviz interaction.md).
        // Kept 44px inside each edge, so the first and last bars' readouts stay on the card.
        <div className="bar-chart-tip" style={{ left: Math.min(width - 44, Math.max(44, xOf(active) + barW / 2)) }} aria-hidden="true">
          <strong>{format(shown.value, unit, currency)}</strong>
          <span>{shown.label}</span>
        </div>
      )}
      <div className="visually-hidden" aria-live="polite">
        {shown ? `${shown.label}: ${format(shown.value, unit, currency)}` : ''}
      </div>
      {/* Wrapped: a <table> ignores width: 1px and sizes to its content, so
          on its own it widened a phone's page by 78px. The wrapper clips it. */}
      <div className="visually-hidden">
        <table>
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
      </div>
    </figure>
  );
}

/**
 * A two-value split as one stacked bar with both numbers written beside it:
 * web vs staff. The two parts are separated by a 2px gap of the surface
 * (dataviz marks-and-anatomy), so the split reads without the colours.
 */
export function SplitBar({ a, b, labelA, labelB }: { a: number; b: number; labelA: string; labelB: string }) {
  const total = a + b;
  const pa = total === 0 ? 50 : (a / total) * 100;
  return (
    <div className="split-bar" role="img" aria-label={`${labelA} ${a}, ${labelB} ${b}`}>
      <div className="split-bar-track">
        {a > 0 && <div className="split-bar-a" style={{ flexBasis: `${pa}%` }} />}
        {b > 0 && <div className="split-bar-b" />}
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
