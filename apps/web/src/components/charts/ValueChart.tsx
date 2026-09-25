/**
 * A value over time as a single line with a soft fill and no axes. Scrubbing
 * reports the point under the pointer so the caller can show that value.
 */

import { useEffect, useId, useRef, useState } from "react";
import { smoothPath } from "../../lib/series.ts";

export interface ValuePoint {
  /** Milliseconds. */
  readonly t: number;
  readonly v: number;
}

export function ValueChart({
  points,
  up,
  height = 180,
  onScrub,
  empty,
}: {
  points: readonly ValuePoint[];
  up: boolean;
  height?: number;
  onScrub?: (point: ValuePoint | null) => void;
  /** Said in place of the line when there is none. */
  empty?: React.ReactNode;
}) {
  const id = useId().replace(/:/g, "");
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // A new range or new data is a new line; nothing stays scrubbed. Keyed on
  // what the line is, not the array, so a caller re-rendering mid-scrub with
  // the same data does not cancel the scrub.
  const shape = points.length
    ? `${points[0]!.t}-${points[points.length - 1]!.t}-${points.length}-${points[points.length - 1]!.v}`
    : "";
  useEffect(() => {
    setActive(null);
    onScrub?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape]);

  const stroke = up ? "hsl(var(--chart-up))" : "hsl(var(--chart-down))";

  if (points.length < 2) {
    return (
      <div className="value-chart empty" ref={box} style={{ height }}>
        {empty ?? null}
      </div>
    );
  }

  const PAD_Y = 14;
  const values = points.map((p) => p.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  // At least a few percent of the value tall: thin markets tick up and down
  // by fractions of a percent every hour, and a line scaled to that noise
  // alone draws a calm day as a seismograph.
  const floor = Math.abs(max) * 0.03;
  const spread = max - min;
  const span = Math.max(spread, floor) || 1;
  const low = spread < floor ? min - (floor - spread) / 2 : min;
  const t0 = points[0]!.t;
  const t1 = points[points.length - 1]!.t;
  const x = (t: number) => (t1 === t0 ? 0 : ((t - t0) / (t1 - t0)) * width);
  const y = (v: number) => PAD_Y + (1 - (v - low) / span) * (height - PAD_Y * 2);
  const line = smoothPath(points.map((p) => ({ x: x(p.t), y: y(p.v) })));
  const area = `${line}L${width},${height}L0,${height}Z`;

  const pick = (clientX: number) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect || width === 0) return;
    const at = t0 + ((clientX - rect.left) / rect.width) * (t1 - t0);
    let best = 0;
    for (let i = 1; i < points.length; i++) {
      if (Math.abs(points[i]!.t - at) < Math.abs(points[best]!.t - at)) best = i;
    }
    if (best !== active) {
      setActive(best);
      onScrub?.(points[best]!);
    }
  };
  const release = () => {
    setActive(null);
    onScrub?.(null);
  };

  const point = active === null ? null : points[active]!;
  // Redrawn for a new range, not for each new price at its end.
  const drawKey = `${points.length}-${Math.round(t0 / 3_600_000)}`;

  return (
    <div
      className="value-chart"
      ref={box}
      style={{ height }}
      onPointerDown={(event) => {
        (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
        pick(event.clientX);
      }}
      onPointerMove={(event) => {
        if (event.pointerType === "mouse" || event.buttons > 0) pick(event.clientX);
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse") release();
      }}
    >
      {width > 0 ? (
        <svg width={width} height={height} role="img" aria-label="Value over time">
          <defs>
            <linearGradient id={`vc-${id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style={{ stopColor: stroke }} stopOpacity="0.18" />
              <stop offset="100%" style={{ stopColor: stroke }} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path key={`fill-${drawKey}`} className="draw-fill" d={area} fill={`url(#vc-${id})`} />
          <path
            key={`line-${drawKey}`}
            className="draw"
            pathLength={1}
            d={line}
            fill="none"
            style={{ stroke }}
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {point ? (
            <g pointerEvents="none">
              <line x1={x(point.t)} x2={x(point.t)} y1={0} y2={height} className="value-chart-cross" />
              <circle cx={x(point.t)} cy={y(point.v)} r="5.5" style={{ fill: "hsl(var(--raised))", stroke }} strokeWidth="2.5" />
            </g>
          ) : null}
        </svg>
      ) : null}
    </div>
  );
}
