/**
 * Chart series arithmetic, kept free of React for testing. Series answer
 * "what would $1,000 have become" or "what have current holdings been
 * worth", rather than showing raw token prices whose scales differ widely.
 */

export interface HistoryTable {
  readonly days: readonly string[];
  readonly prices: Readonly<Record<string, readonly (number | null)[]>>;
}

/** Carry the last known value forward over gaps; leading gaps stay null. */
export function forwardFill(values: readonly (number | null)[]): (number | null)[] {
  let last: number | null = null;
  return values.map((value) => {
    if (value !== null && Number.isFinite(value)) last = value;
    return last;
  });
}

/**
 * Daily value of `startValue` invested in a basket on day `from`. Weights are
 * renormalised over the companies priced on that day, since a company listed
 * later cannot have been bought then.
 */
export function basketSeries(
  table: HistoryTable,
  weights: readonly { readonly symbol: string; readonly weight: number }[],
  startValue: number,
  from = 0,
): (number | null)[] {
  const filled = new Map(weights.map((w) => [w.symbol, forwardFill(table.prices[w.symbol] ?? [])]));
  const priced = weights.filter((w) => (filled.get(w.symbol)?.[from] ?? null) !== null && w.weight > 0);
  const total = priced.reduce((sum, w) => sum + w.weight, 0);
  if (total <= 0) return table.days.map(() => null);

  const units = priced.map((w) => ({
    symbol: w.symbol,
    units: (startValue * (w.weight / total)) / filled.get(w.symbol)![from]!,
  }));
  return table.days.map((_, i) => {
    if (i < from) return null;
    let value = 0;
    for (const u of units) {
      const price = filled.get(u.symbol)![i];
      if (price === null || price === undefined) return null;
      value += u.units * price;
    }
    return value;
  });
}

/**
 * Daily value of a fixed set of holdings at past prices (not the wallet's
 * actual history). A day on which any holding lacks a price is null.
 */
export function holdingsSeries(
  table: HistoryTable,
  units: Readonly<Record<string, number>>,
): (number | null)[] {
  const held = Object.entries(units).filter(([, amount]) => amount > 0);
  const filled = new Map(held.map(([symbol]) => [symbol, forwardFill(table.prices[symbol] ?? [])]));
  return table.days.map((_, i) => {
    let value = 0;
    for (const [symbol, amount] of held) {
      const price = filled.get(symbol)![i];
      if (price === null || price === undefined) return null;
      value += amount * price;
    }
    return held.length > 0 ? value : null;
  });
}

/**
 * Indices to keep so a long series draws as a smooth line: every `step`th
 * point, always including the first and the last.
 */
export function sampleIndices(length: number, target = 52): number[] {
  if (length <= target) return Array.from({ length }, (_, i) => i);
  const step = Math.max(1, Math.round(length / target));
  const indices: number[] = [];
  for (let i = 0; i < length; i += step) indices.push(i);
  if (indices[indices.length - 1] !== length - 1) indices.push(length - 1);
  return indices;
}

/** Index of the first non-null value, or -1. */
export function firstValue(values: readonly (number | null)[]): number {
  return values.findIndex((v) => v !== null);
}

/**
 * Axis ticks on round numbers with a little headroom. Starts at zero unless
 * the series stays in a narrow band far from zero, where a zero-based axis
 * would draw a flat line; then it starts at a round number below the minimum.
 */
export function niceTicks(max: number, count = 4, min = 0): number[] {
  if (!(max > 0) || !Number.isFinite(max)) return [0, 1];
  const narrow = min > 0 && min / max > 0.55;
  const floorTarget = narrow ? Math.max(0, min - (max - min) * 0.8) : 0;
  const rough = (max - floorTarget) / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? 10 * magnitude;
  const bottom = narrow ? Math.floor(floorTarget / step) * step : 0;
  const top = Math.ceil((max + (max - bottom) * 0.04) / step) * step;
  const ticks: number[] = [];
  for (let v = bottom; v <= top + step / 2; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}

/** Axis labels: "$40K", "$1.2K", "$950", "$2.30". Unsigned. */
export function axisUsd(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `$${trim(abs / 1_000_000)}M`;
  if (abs >= 1_000) return `$${trim(abs / 1_000)}K`;
  if (abs >= 10) return `$${Math.round(abs)}`;
  if (abs === 0) return "$0";
  return `$${abs.toFixed(2)}`;
}

function trim(value: number): string {
  return value >= 100 ? Math.round(value).toString() : Number(value.toFixed(1)).toString();
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * A smooth path through points that never overshoots them.
 *
 * Monotone cubic interpolation (Fritsch–Carlson): a plain spline through a
 * price series bulges above a peak and below a trough, drawing highs and lows
 * that never traded. This keeps the curve's look without inventing prices.
 */
export function smoothPath(points: readonly Point[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M${f(points[0]!.x)},${f(points[0]!.y)}`;
  const n = points.length;
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = points[i + 1]!.x - points[i]!.x;
    slope[i] = dx[i] === 0 ? 0 : (points[i + 1]!.y - points[i]!.y) / dx[i]!;
  }
  const tangent: number[] = [slope[0]!];
  for (let i = 1; i < n - 1; i++) {
    tangent[i] = slope[i - 1]! * slope[i]! <= 0 ? 0 : (slope[i - 1]! + slope[i]!) / 2;
  }
  tangent[n - 1] = slope[n - 2]!;
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      tangent[i] = 0;
      tangent[i + 1] = 0;
      continue;
    }
    const a = tangent[i]! / slope[i]!;
    const b = tangent[i + 1]! / slope[i]!;
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      tangent[i] = t * a * slope[i]!;
      tangent[i + 1] = t * b * slope[i]!;
    }
  }
  let d = `M${f(points[0]!.x)},${f(points[0]!.y)}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[i]!;
    const p1 = points[i + 1]!;
    const h = dx[i]! / 3;
    d += `C${f(p0.x + h)},${f(p0.y + h * tangent[i]!)},${f(p1.x - h)},${f(p1.y - h * tangent[i + 1]!)},${f(p1.x)},${f(p1.y)}`;
  }
  return d;
}

const f = (value: number) => (Math.round(value * 10) / 10).toString();

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "June", "July", "Aug", "Sept", "Oct", "Nov", "Dec"];

/** "2 June" for an ISO day. */
export function dayLabel(iso: string): string {
  const [, month, day] = iso.split("-").map(Number);
  return `${day} ${MONTHS[(month ?? 1) - 1]}`;
}

/**
 * Where to put x-axis labels: month names at each month's first day for
 * ranges longer than about six weeks, otherwise a handful of dates.
 */
export function xLabels(days: readonly string[]): { index: number; label: string }[] {
  if (days.length === 0) return [];
  if (days.length > 45) {
    const labels: { index: number; label: string }[] = [];
    let lastMonth = "";
    days.forEach((day, index) => {
      const month = day.slice(0, 7);
      if (month !== lastMonth) {
        lastMonth = month;
        // The first, partial month would crowd the axis edge.
        if (index > 2) labels.push({ index, label: MONTHS[Number(day.slice(5, 7)) - 1]! });
      }
    });
    return labels;
  }
  const count = Math.min(6, days.length);
  return Array.from({ length: count }, (_, i) => {
    const index = Math.round((i * (days.length - 1)) / Math.max(1, count - 1));
    return { index, label: dayLabel(days[index]!) };
  });
}
