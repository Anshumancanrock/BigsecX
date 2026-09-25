/**
 * The phone's screen: the app's wealth view at a fixed 390 x 845 design size,
 * in DOM and SVG so its text stays sharp. The three.js scene positions this
 * element over the glass with a CSS 3D transform; without WebGL it sits in a
 * flat frame. Every 900 ms the balance steps, the chart scrolls one point
 * left, and changed digits pop in with a 70 ms stagger.
 */

import { useEffect, useRef, useState } from "react";
import {
  CHART,
  TICK_MS,
  TIMEFRAMES,
  axisLabels,
  fmtChange,
  fmtUsd,
  polygon,
  polyline,
  stepOf,
  tick,
  yOf,
  type Frame,
  type Timeframe,
} from "./phone-model.ts";
import { popDigits, type Digit } from "../lib/digits.ts";

export interface PhoneHolding {
  readonly symbol: string;
  readonly name: string;
  readonly glyph: string;
  readonly tag: string;
  readonly price: string;
  readonly value: string;
  readonly change: string;
  readonly up: boolean;
}

const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function PhoneScreen({
  frames,
  holdings,
  active,
}: {
  frames: ReadonlyMap<Timeframe, Frame>;
  holdings: readonly PhoneHolding[];
  active: boolean;
}) {
  const [timeframe, setTimeframe] = useState<Timeframe>("1M");
  const frame = frames.get(timeframe) ?? [...frames.values()][0]!;
  const [live, setLive] = useState(() => ({ balance: frame.balance, points: frame.points }));

  useEffect(() => {
    setLive({ balance: frame.balance, points: frame.points });
  }, [frame]);

  useEffect(() => {
    if (!active || reducedMotion()) return;
    const id = setInterval(() => {
      setLive((current) => tick({ ...current, range: frame.range }, Math.random));
    }, TICK_MS);
    return () => clearInterval(id);
  }, [active, frame]);

  const [whole, cents] = fmtUsd(live.balance).split(".");
  const change = fmtChange(live.balance - frame.base, frame.base);

  return (
    <>
      <div className="ps-app">
        <StatusBar />
        <div className="ps-tabs">
          <div className="ps-tabs-row">
            <span className="ps-tab">Feed</span>
            <span className="ps-tab on">Pre-stocks</span>
            <span className="ps-tab">Basket</span>
          </div>
          <span className="ps-avatar">B</span>
        </div>

        <div className="ps-body">
          <div className="ps-balance-block">
            <div className="ps-balance">
              <PopDigits value={whole!} />
              <PopDigits className="ps-cents" value={`.${cents}`} />
            </div>
            <div className={`ps-change ${change.startsWith("-") ? "down" : "up"}`}>
              <PopDigits value={change} />
            </div>
          </div>

          <div className="ps-pills">
            {TIMEFRAMES.map((t) => (
              <button
                key={t}
                type="button"
                tabIndex={-1}
                className={`ps-pill${t === timeframe ? " on" : ""}`}
                onClick={() => setTimeframe(t)}
              >
                {t}
              </button>
            ))}
          </div>

          <div className="ps-chart">
            <Chart points={live.points} range={frame.range} />
          </div>

          <div className="ps-card">
            <span className="ps-card-mark" aria-hidden="true">
              ✦
            </span>
            <div className="ps-card-text">
              <div className="ps-card-title">Copy a trader in one tap</div>
              <div className="ps-card-body">See what the best wallets hold, then buy the same mix with your own money.</div>
              <div className="ps-card-dots" aria-hidden="true">
                <span />
                <span className="on" />
                <span />
              </div>
            </div>
            <span className="ps-card-close" aria-hidden="true">
              ✕
            </span>
          </div>

          <div className="ps-section-head">
            <div>Holdings</div>
            <span>Sell all</span>
          </div>
          <div className="ps-rows">
            {holdings.map((h) => (
              <div className="ps-row" key={h.symbol}>
                <span className="ps-logo">{h.glyph}</span>
                <div className="ps-row-main">
                  <div className="ps-row-title">
                    <span>{h.name}</span>
                    <span className="ps-badge">{h.tag}</span>
                  </div>
                  <div className="ps-row-sub">{h.price}</div>
                </div>
                <div className="ps-row-right">
                  <div className="ps-row-value">{h.value}</div>
                  <div className={`ps-row-change ${h.up ? "up" : "down"}`}>{h.change}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="ps-buttons">
            <span className="ps-glass-button">Buy</span>
            <span className="ps-glass-button">Sell</span>
          </div>
        </div>
      </div>
      <div className="ps-home" aria-hidden="true" />
      <div className="ps-island" aria-hidden="true">
        <span />
      </div>
    </>
  );
}

function StatusBar() {
  return (
    <div className="ps-status">
      <span className="ps-time">9:41</span>
      <span className="ps-status-icons">
        <svg width="18" height="12" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <rect key={i} x={4.6 * i} y={9 - 3 * i} width="3" height={3 + 3 * i} rx="1" fill="#111" />
          ))}
        </svg>
        <svg width="17" height="12" viewBox="0 0 17 12" aria-hidden="true">
          <path d="M8.5 10.8 5.6 7.9a4.4 4.4 0 0 1 5.8 0Zm4.6-4.6a7.4 7.4 0 0 0-9.2 0L2.2 4.5a10 10 0 0 1 12.6 0Z" fill="#111" />
        </svg>
        <svg width="25" height="12" viewBox="0 0 25 12" aria-hidden="true">
          <rect x="0.5" y="0.5" width="21" height="11" rx="3" fill="none" stroke="#111" strokeOpacity="0.4" />
          <rect x="2" y="2" width="12" height="8" rx="1.5" fill="#111" />
          <path d="M23 4v4a2.2 2.2 0 0 0 0-4Z" fill="#111" fillOpacity="0.4" />
        </svg>
      </span>
    </div>
  );
}

function PopDigits({ value, className = "" }: { value: string; className?: string }) {
  const previous = useRef<Digit[] | null>(null);
  const nextKey = useRef(0);
  const { digits, nextKey: key } = popDigits(previous.current, value, nextKey.current);
  previous.current = digits;
  nextKey.current = key;
  return (
    <span className={`t-digit-group is-animating ${className}`}>
      {digits.map((d) => (
        <span
          key={d.key}
          className="t-digit"
          style={d.stagger === null ? undefined : ({ "--i": d.stagger } as React.CSSProperties)}
        >
          {d.char === " " ? " " : d.char}
        </span>
      ))}
    </span>
  );
}

function Chart({ points, range }: { points: readonly number[]; range: Frame["range"] }) {
  const line = useRef<SVGGElement>(null);
  const dot = useRef<SVGGElement>(null);
  const previous = useRef(points);
  const step = stepOf(points.length);

  useEffect(() => {
    const before = previous.current;
    previous.current = points;
    if (before === points || before.length !== points.length || reducedMotion()) return;
    if (before[1] !== points[0]) return;
    const timing = { duration: TICK_MS, easing: "linear" };
    line.current?.animate([{ transform: `translateX(${step}px)` }, { transform: "translateX(0px)" }], timing);
    const dy = yOf(before[before.length - 1]!) - yOf(points[points.length - 1]!);
    dot.current?.animate([{ transform: `translateY(${dy}px)` }, { transform: "translateY(0px)" }], timing);
  }, [points, step]);

  const end = points[points.length - 1]!;
  const endX = CHART.width - CHART.rightGutter;

  return (
    <svg width={CHART.width} height={CHART.height} aria-hidden="true">
      <defs>
        <linearGradient id="ps-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#111" stopOpacity="0.08" />
          <stop offset="100%" stopColor="#111" stopOpacity="0" />
        </linearGradient>
      </defs>
      <g ref={line}>
        <polygon points={polygon(points)} fill="url(#ps-fill)" />
        <polyline points={polyline(points)} fill="none" stroke="#111" strokeWidth="2.5" strokeLinejoin="round" />
      </g>
      {axisLabels(range).map((l) => (
        <text key={l.label} x={CHART.width - 4} y={l.y} textAnchor="end" fontSize="12" fill="#9ca3af">
          {l.label}
        </text>
      ))}
      <g ref={dot}>
        <circle cx={endX} cy={yOf(end)} r="10" fill="#111" opacity="0.15" />
        <circle cx={endX} cy={yOf(end)} r="5" fill="#111" />
      </g>
    </svg>
  );
}
