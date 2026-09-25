/**
 * A company's price over time, full size and as a card sparkline. Green when
 * the range ends higher than it began. The axis is fitted to the data rather
 * than starting at zero, which would flatten moves of a few percent.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { price } from "../../lib/format.ts";
import { smoothPath } from "../../lib/series.ts";

export interface PricePoint {
  /** Unix milliseconds. */
  readonly t: number;
  readonly v: number | null;
}

export type Grain = "hour" | "week" | "day" | "year";

const PAD = { top: 14, right: 12, bottom: 30, left: 68 };

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

const TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const MONTH = new Intl.DateTimeFormat("en-GB", { month: "short", year: "2-digit" });
const FULL = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const FULL_DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

function axisLabel(t: number, grain: Grain): string {
  const date = new Date(t);
  if (grain === "hour") return TIME.format(date);
  if (grain === "year") return MONTH.format(date).replace(" ", " '");
  return DAY.format(date);
}

export function PriceChart({ points, grain, height = 320 }: { points: readonly PricePoint[]; grain: Grain; height?: number }) {
  const [box, width] = useWidth<HTMLDivElement>();
  const id = useId().replace(/:/g, "");
  const [hover, setHover] = useState<number | null>(null);

  const valid = useMemo(() => points.filter((p): p is { t: number; v: number } => p.v !== null), [points]);
  const first = valid[0]?.v ?? null;
  const last = valid[valid.length - 1]?.v ?? null;
  const up = first !== null && last !== null ? last >= first : true;
  // Through the theme, so the line is a readable green on the light phone
  // page and the same mint as before on the dark one. A CSS variable only
  // works in a style, not in an SVG attribute, hence style= below.
  const stroke = up ? "hsl(var(--chart-up))" : "hsl(var(--chart-down))";

  if (valid.length < 2) {
    return (
      <div className="price-chart" ref={box} style={{ height }}>
        <div className="chart-empty" style={{ height }}>
          {points.length ? "Not enough trades in this range to draw a line." : null}
        </div>
      </div>
    );
  }

  const values = valid.map((p) => p.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = (max - min || max * 0.02 || 1) * 0.08;
  const lo = min - pad;
  const hi = max + pad;
  const t0 = valid[0]!.t;
  const t1 = valid[valid.length - 1]!.t;

  const innerW = Math.max(0, width - PAD.left - PAD.right);
  const innerH = height - PAD.top - PAD.bottom;
  const x = (t: number) => PAD.left + ((t - t0) / (t1 - t0 || 1)) * innerW;
  const y = (v: number) => PAD.top + innerH - ((v - lo) / (hi - lo || 1)) * innerH;

  // Monotone curves: smooth, and never above a high or below a low that traded.
  const line = smoothPath(valid.map((p) => ({ x: x(p.t), y: y(p.v) })));
  const base = PAD.top + innerH;
  const area = `${line}L${x(t1).toFixed(1)},${base}L${x(t0).toFixed(1)},${base}Z`;

  // Five price labels, top to bottom, evenly spaced across the drawn range.
  const ticks = Array.from({ length: 5 }, (_, i) => hi - ((hi - lo) * i) / 4);
  // As many time labels as fit, about one per 110px.
  const count = Math.max(2, Math.min(7, Math.floor(innerW / 110)));
  const times = Array.from({ length: count }, (_, i) => t0 + ((t1 - t0) * i) / (count - 1));

  const drawKey = `${t0}-${t1}-${valid.length}`;
  const active = hover !== null ? valid[hover] ?? null : null;
  const tipLeft = active ? x(active.t) : 0;
  const flip = tipLeft > width - 160;

  return (
    <div className="price-chart" ref={box} style={{ height }}>
      {width > 0 ? (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`Price from ${price(first)} to ${price(last)}`}
          onPointerMove={(event) => {
            const rect = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
            const t = t0 + ((event.clientX - rect.left - PAD.left) / Math.max(1, innerW)) * (t1 - t0);
            let best = 0;
            for (let i = 1; i < valid.length; i++) if (Math.abs(valid[i]!.t - t) < Math.abs(valid[best]!.t - t)) best = i;
            setHover(best);
          }}
          onPointerLeave={() => setHover(null)}
        >
          <defs>
            <linearGradient id={`pc-fill-${id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style={{ stopColor: stroke }} stopOpacity="0.22" />
              <stop offset="100%" style={{ stopColor: stroke }} stopOpacity="0" />
            </linearGradient>
          </defs>

          {ticks.map((tick) => (
            <g key={tick}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} className="pc-grid" />
              <text x={PAD.left - 12} y={y(tick) + 4} textAnchor="end" className="axis-label">
                {price(tick)}
              </text>
            </g>
          ))}
          {times.map((t, i) => (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={PAD.top} y2={base} className="pc-grid" />
              {/* The end labels are anchored inward, so neither is cut off at the edge. */}
              <text
                x={x(t)}
                y={height - 8}
                textAnchor={i === 0 ? "start" : i === times.length - 1 ? "end" : "middle"}
                className="axis-label"
              >
                {axisLabel(t, grain)}
              </text>
            </g>
          ))}

          {/* Keyed by the range, so switching range draws the new line in. */}
          <path key={`fill-${drawKey}`} className="draw-fill" d={area} fill={`url(#pc-fill-${id})`} />
          <path
            key={`line-${drawKey}`}
            className="draw"
            pathLength={1}
            d={line}
            fill="none"
            style={{ stroke }}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {active ? (
            <g pointerEvents="none">
              <line x1={x(active.t)} x2={x(active.t)} y1={PAD.top} y2={base} className="pc-cross" />
              <circle cx={x(active.t)} cy={y(active.v)} r="5" style={{ fill: "hsl(var(--raised))", stroke }} strokeWidth="2.5" />
            </g>
          ) : null}
        </svg>
      ) : null}

      {active ? (
        <div
          className="chart-tip"
          style={{
            left: flip ? undefined : tipLeft + 12,
            right: flip ? width - tipLeft + 12 : undefined,
            top: Math.max(4, y(active.v) - 56),
          }}
        >
          <b>{price(active.v)}</b>
          <span>{grain === "hour" || grain === "week" ? FULL.format(new Date(active.t)) : FULL_DAY.format(new Date(active.t))}</span>
        </div>
      ) : null}
    </div>
  );
}

/** The card's line: no axes, no labels, the shape of the move and its colour. */
export function Sparkline({ values, up, height = 96 }: { values: readonly (number | null)[]; up: boolean; height?: number }) {
  const id = useId().replace(/:/g, "");
  const series = values.filter((v): v is number => v !== null);
  if (series.length < 2) return <div className="sparkline" style={{ height }} />;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || max * 0.01 || 1;
  const W = 100;
  const H = 40;
  const line = smoothPath(series.map((v, i) => ({ x: (i / (series.length - 1)) * W, y: H - 3 - ((v - min) / span) * (H - 8) })));
  // Through the theme, so the line is a readable green on the light phone
  // page and the same mint as before on the dark one. A CSS variable only
  // works in a style, not in an SVG attribute, hence style= below.
  const stroke = up ? "hsl(var(--chart-up))" : "hsl(var(--chart-down))";
  return (
    // Revealed left to right rather than drawn with a dash: this line is
    // stretched to the card, and a dash measured on a stretched path breaks
    // the line into pieces.
    <svg className="sparkline reveal" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height }} aria-hidden="true">
      <defs>
        <linearGradient id={`sp-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style={{ stopColor: stroke }} stopOpacity="0.2" />
          <stop offset="100%" style={{ stopColor: stroke }} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line}L${W},${H}L0,${H}Z`} fill={`url(#sp-${id})`} />
      <path
        d={line}
        fill="none"
        style={{ stroke }}
        strokeWidth="1.6"
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
      />
    </svg>
  );
}
