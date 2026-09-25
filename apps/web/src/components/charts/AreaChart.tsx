import { useEffect, useId, useMemo, useRef, useState } from "react";
import { axisUsd, dayLabel, niceTicks, smoothPath, xLabels, type Point } from "../../lib/series.ts";
import { usd } from "../../lib/format.ts";

const PAD = { top: 18, right: 10, bottom: 30, left: 46 };

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(el.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

export function AreaChart({
  days,
  primary,
  secondary,
  primaryLabel,
  secondaryLabel,
  height = 280,
}: {
  days: readonly string[];
  primary: readonly (number | null)[];
  secondary?: readonly (number | null)[] | undefined;
  primaryLabel: string;
  secondaryLabel?: string | undefined;
  height?: number;
}) {
  const [box, width] = useWidth<HTMLDivElement>();
  const id = useId().replace(/:/g, "");
  const lastIndex = useMemo(() => {
    for (let i = primary.length - 1; i >= 0; i--) if (primary[i] !== null) return i;
    return -1;
  }, [primary]);
  const [hover, setHover] = useState<number | null>(null);
  const active = hover ?? lastIndex;

  const values = [...primary, ...(secondary ?? [])].filter((v): v is number => v !== null);
  const ticks = niceTicks(values.length ? Math.max(...values) : 0, 4, values.length ? Math.min(...values) : 0);
  const bottomTick = ticks[0]!;
  const top = ticks[ticks.length - 1]!;

  const innerW = Math.max(0, width - PAD.left - PAD.right);
  const innerH = height - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (days.length <= 1 ? innerW : (i / (days.length - 1)) * innerW);
  const y = (v: number) => PAD.top + innerH - ((v - bottomTick) / (top - bottomTick || 1)) * innerH;

  const pointsOf = (series: readonly (number | null)[]): Point[] =>
    series.flatMap((v, i) => (v === null ? [] : [{ x: x(i), y: y(v) }]));
  const main = pointsOf(primary);
  const other = secondary ? pointsOf(secondary) : [];
  const line = smoothPath(main);
  const baseline = PAD.top + innerH;
  const area =
    main.length > 1 ? `${line}L${main[main.length - 1]!.x},${baseline}L${main[0]!.x},${baseline}Z` : "";

  // As many date labels as fit without touching: about one per 70px.
  const allLabels = xLabels(days);
  const room = Math.max(2, Math.floor(innerW / 70));
  const every = Math.max(1, Math.ceil(allLabels.length / room));
  const labels = allLabels.filter((_, i) => i % every === 0);
  const drawKey = `${days[0] ?? ""}-${days.length}`;
  const activeValue = active >= 0 ? primary[active] : null;
  const activeOther = active >= 0 && secondary ? secondary[active] : null;
  const tipLeft = active >= 0 ? x(active) : 0;
  const flip = tipLeft > width - 170;

  return (
    <div className="area-chart" ref={box} style={{ height }}>
      {width > 0 && main.length > 1 ? (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`${primaryLabel}: ${activeValue !== null && activeValue !== undefined ? usd(activeValue) : "no data"}`}
          onPointerMove={(event) => {
            const rect = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
            const px = event.clientX - rect.left;
            const i = Math.round(((px - PAD.left) / Math.max(1, innerW)) * (days.length - 1));
            const clamped = Math.max(0, Math.min(days.length - 1, i));
            setHover(primary[clamped] === null ? null : clamped);
          }}
          onPointerLeave={() => setHover(null)}
        >
          <defs>
            <linearGradient id={`fill-${id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style={{ stopColor: "hsl(var(--chart-accent))" }} stopOpacity="0.30" />
              <stop offset="70%" style={{ stopColor: "hsl(var(--chart-accent))" }} stopOpacity="0.04" />
              <stop offset="100%" style={{ stopColor: "hsl(var(--chart-accent))" }} stopOpacity="0" />
            </linearGradient>
            <pattern id={`rules-${id}`} width="5" height="8" patternUnits="userSpaceOnUse">
              <rect x="0" y="0" width="1" height="8" fill="hsl(149 88% 80%)" fillOpacity="0.28" />
            </pattern>
            <linearGradient id={`fade-${id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#fff" stopOpacity="1" />
              <stop offset="100%" stopColor="#fff" stopOpacity="0" />
            </linearGradient>
            <mask id={`mask-${id}`}>
              <rect x="0" y="0" width={width} height={height} fill={`url(#fade-${id})`} />
            </mask>
            <linearGradient id={`cross-${id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style={{ stopColor: "hsl(var(--ink))" }} stopOpacity="0" />
              <stop offset="25%" style={{ stopColor: "hsl(var(--ink))" }} stopOpacity="0.7" />
              <stop offset="100%" style={{ stopColor: "hsl(var(--ink))" }} stopOpacity="0.15" />
            </linearGradient>
            <filter id={`glow-${id}`} x="-10%" y="-40%" width="120%" height="180%">
              <feGaussianBlur stdDeviation="5" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={y(tick)}
                y2={y(tick)}
                style={{ stroke: "hsl(var(--ink) / 0.05)" }}
                strokeDasharray="2 6"
              />
              <text x={PAD.left - 12} y={y(tick) + 4} textAnchor="end" className="axis-label">
                {axisUsd(tick)}
              </text>
            </g>
          ))}

          {/* Keyed by the range, so a new range draws in rather than snapping. */}
          <g key={`area-${drawKey}`} className="draw-fill">
            <path d={area} fill={`url(#fill-${id})`} />
            <path d={area} fill={`url(#rules-${id})`} mask={`url(#mask-${id})`} />
          </g>

          {other.length > 1 ? (
            <path
              key={`other-${drawKey}`}
              className="draw-fill"
              d={smoothPath(other)}
              fill="none"
              style={{ stroke: "hsl(var(--ink) / 0.75)" }}
              strokeWidth="1.6"
              strokeDasharray="0.1 5"
              strokeLinecap="round"
            />
          ) : null}

          <path
            key={`line-${drawKey}`}
            className="draw"
            pathLength={1}
            d={line}
            fill="none"
            style={{ stroke: "hsl(var(--chart-accent))" }}
            strokeWidth="3"
            strokeLinecap="round"
            filter={`url(#glow-${id})`}
          />

          {labels.map((l) => (
            <text key={l.index} x={x(l.index)} y={height - 8} textAnchor="middle" className="axis-label">
              {l.label}
            </text>
          ))}

          {activeValue !== null && activeValue !== undefined ? (
            <g pointerEvents="none">
              <line x1={x(active)} x2={x(active)} y1={PAD.top - 6} y2={baseline} stroke={`url(#cross-${id})`} strokeWidth="1.2" />
              <circle cx={x(active)} cy={y(activeValue)} r="6.5" style={{ fill: "hsl(var(--raised))", stroke: "hsl(var(--chart-accent))" }} strokeWidth="2.5" />
            </g>
          ) : null}
        </svg>
      ) : (
        <div className="chart-empty">{width > 0 ? "Not enough price history yet." : null}</div>
      )}

      {width > 0 && main.length > 1 && activeValue !== null && activeValue !== undefined ? (
        <div
          className="chart-tip"
          style={{
            left: flip ? undefined : tipLeft + 12,
            right: flip ? width - tipLeft + 12 : undefined,
            top: Math.max(4, y(activeValue) - 64),
          }}
        >
          <b>{dayLabel(days[active]!)}</b>
          <span>
            <i className="dot solid" /> {usd(activeValue)}
          </span>
          {activeOther !== null && activeOther !== undefined && secondaryLabel ? (
            <span>
              <i className="dot dotted" /> {usd(activeOther)}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
