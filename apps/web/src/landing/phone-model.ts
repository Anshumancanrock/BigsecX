/**
 * The landing phone's model, free of React and three.js so it can be tested.
 * Each timeframe's chart is the Everything basket's actual price history and
 * the balance is what $10,000 invested at its start is worth today; the
 * balance then ticks every 900 ms while the chart scrolls with it.
 */

import { basketSeries, firstValue, type HistoryTable } from "../lib/series.ts";

/*
 * The basket's history is a little over six months, so "1Y" would equal
 * "Max", and daily closes are too coarse for "1D". The first timeframe is
 * the default.
 */
export const TIMEFRAMES = ["1M", "3M", "6M", "Max"] as const;

export type Timeframe = (typeof TIMEFRAMES)[number];

const DAYS: Record<Timeframe, number> = { "1M": 30, "3M": 90, "6M": 182, Max: Infinity };

/** Points on the chart. One more than drawn, so a tick can scroll one in. */
export const CURVE_POINTS = 44;

/** How often the demo ticks, and how far one tick can move the balance. */
export const TICK_MS = 900;

const TICK_STEP = 6e-4;

/* ------------------------------------------------------------- the money */

const usd0 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

const usd2 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function fmtUsd(value: number, decimals = 2): string {
  return `$${(decimals === 0 ? usd0 : usd2).format(value)}`;
}

/** "+$2,536.55 (+24.6%)" or "-$158.62 (-1.23%)". */
export function fmtChange(delta: number, base: number): string {
  const pct = base > 0 ? (delta / base) * 100 : 0;
  const sign = delta < 0 ? "-" : "+";
  const digits = Math.abs(pct) < 10 ? 2 : 1;
  return `${sign}${fmtUsd(Math.abs(delta))} (${pct < 0 ? "-" : "+"}${Math.abs(pct).toFixed(digits)}%)`;
}

/* ------------------------------------------------------------- the curve */

export interface Range {
  readonly lo: number;
  readonly hi: number;
}

/** The value range a curve is drawn against, with room above and below. */
export function rangeOf(values: readonly number[]): Range {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = (max - min || max * 0.05 || 1) * 0.35;
  return { lo: Math.max(0, min - pad), hi: max + pad * 0.6 };
}

/** A value as a fraction of its range, kept inside the drawable band. */
export function normalise(value: number, range: Range): number {
  return Math.min(1, Math.max(0.02, (value - range.lo) / (range.hi - range.lo || 1)));
}

/** Resample a series to exactly `count` points by linear interpolation. */
export function resample(values: readonly number[], count: number): number[] {
  if (values.length === 0) return [];
  if (values.length === 1) return Array.from({ length: count }, () => values[0]!);
  return Array.from({ length: count }, (_, i) => {
    const at = (i / (count - 1)) * (values.length - 1);
    const lo = Math.floor(at);
    const hi = Math.min(values.length - 1, lo + 1);
    return values[lo]! + (values[hi]! - values[lo]!) * (at - lo);
  });
}

/**
 * The next point of a curve being ticked forward: half the last step carried
 * on, a little noise, and a pull toward the current balance, so the line
 * wanders like a price and still follows the number above it.
 */
export function swing(beforeLast: number, last: number, target: number, random: number): number {
  return last + (last - beforeLast) * 0.5 + (random - 0.5) * 0.16 + (target - last) * 0.15;
}

/** One tick: the balance moves a hair, and the curve takes a step to match. */
export function tick(
  state: { balance: number; points: readonly number[]; range: Range },
  random: () => number,
): { balance: number; points: number[] } {
  const balance = state.balance * (1 + (random() - 0.5) * TICK_STEP);
  const target = normalise(balance, state.range);
  const last = state.points[state.points.length - 1] ?? target;
  const beforeLast = state.points[state.points.length - 2] ?? last;
  const next = Math.min(1, Math.max(0.02, swing(beforeLast, last, target, random())));
  return { balance, points: [...state.points.slice(1), next] };
}

/* ------------------------------------------------------------ the frames */

export interface Frame {
  readonly timeframe: Timeframe;
  /** What the demo position is worth now. */
  readonly balance: number;
  /** What it was worth at the start of this timeframe. */
  readonly base: number;
  /** Normalised to the range, CURVE_POINTS long. */
  readonly points: readonly number[];
  readonly range: Range;
}

/**
 * The demo position, from real history: $10,000 put into a basket at the
 * start of its history, then each timeframe's window of that same line.
 */
export function framesFromHistory(
  table: HistoryTable,
  weights: readonly { symbol: string; weight: number }[],
): Map<Timeframe, Frame> | null {
  if (table.days.length < 8 || weights.length === 0) return null;
  // Start where most of the basket had a price, as the dashboard does.
  const total = weights.reduce((sum, w) => sum + w.weight, 0) || 1;
  let from = 0;
  for (let i = 0; i < table.days.length; i++) {
    const covered = weights.reduce((sum, w) => sum + ((table.prices[w.symbol]?.[i] ?? null) !== null ? w.weight : 0), 0);
    if (covered / total >= 0.8) {
      from = i;
      break;
    }
  }
  const line = basketSeries(table, weights, 10_000, from);
  const start = firstValue(line);
  if (start < 0) return null;
  const values = line.slice(start).filter((v): v is number => v !== null);
  if (values.length < 8) return null;
  const balance = values[values.length - 1]!;

  const frames = new Map<Timeframe, Frame>();
  for (const timeframe of TIMEFRAMES) {
    const window = values.slice(-Math.min(values.length, DAYS[timeframe] + 1));
    const range = rangeOf(window);
    frames.set(timeframe, {
      timeframe,
      balance,
      base: window[0]!,
      points: resample(window, CURVE_POINTS).map((v) => normalise(v, range)),
      range,
    });
  }
  return frames;
}

/** A seeded generator, so a fallback demo draws the same line every visit. */
export function seeded(seed: string): () => number {
  let h = 0x6a09e667;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 0xcc9e2d51);
    h = (h << 13) | (h >>> 19);
  }
  let state = h >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

/**
 * Frames for when no history could be loaded: a trend with a wandering
 * offset, so the hero never shows an empty phone. Used only when the API is
 * unreachable.
 */
export function fallbackFrames(): Map<Timeframe, Frame> {
  const range: Range = { lo: 4_890, hi: 16_000 };
  const balance = 12_847.32;
  const target = normalise(balance, range);
  const frames = new Map<Timeframe, Frame>();
  for (const timeframe of TIMEFRAMES) {
    const random = seeded(`basketx${timeframe}`);
    const startAt = 0.15 + 0.15 * random();
    const points: number[] = [];
    let before = 0;
    let offset = 0;
    for (let i = 0; i < CURVE_POINTS; i++) {
      const trend = startAt + (i / (CURVE_POINTS - 1)) * (target - startAt);
      points.push(Math.min(1, Math.max(0.02, trend + offset)));
      [before, offset] = [offset, swing(before, offset, 0, random())];
    }
    const base = range.lo + startAt * (range.hi - range.lo);
    frames.set(timeframe, { timeframe, balance, base, points, range });
  }
  return frames;
}

/* ------------------------------------------------------------- the chart */

export const CHART = { width: 390, height: 215, rightGutter: 64 } as const;

/** y of a normalised value, with 12px kept clear at the top and bottom. */
export function yOf(value: number, height: number = CHART.height): number {
  return height - 12 - value * (height - 24);
}

/** Horizontal distance between points; the first sits one step off-screen. */
export function stepOf(count: number): number {
  return (CHART.width - CHART.rightGutter) / (count - 2);
}

export function polyline(points: readonly number[]): string {
  const step = stepOf(points.length);
  return points.map((v, i) => `${(i - 1) * step},${yOf(v)}`).join(" ");
}

/** The fill under the line, closed along the bottom edge. */
export function polygon(points: readonly number[]): string {
  const step = stepOf(points.length);
  return `${-step},${CHART.height} ${polyline(points)} ${(points.length - 2) * step},${CHART.height}`;
}

/** Three price labels up the right edge. */
export function axisLabels(range: Range): { y: number; label: string }[] {
  return [0.95, 0.62, 0.28].map((v) => ({ y: yOf(v), label: fmtUsd(range.lo + v * (range.hi - range.lo), 0) }));
}
