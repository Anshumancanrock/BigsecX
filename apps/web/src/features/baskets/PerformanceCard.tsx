/**
 * "What $1,000 became" for one basket or company, computed from the daily
 * price history with the same arithmetic as every other chart. Keeps its
 * height while loading so the layout does not shift.
 */

import { useLivePrices } from "../../lib/live.ts";
import { useMarket } from "../../lib/market.ts";
import { useCountUp } from "../../lib/motion.ts";
import { useMemo, useState } from "react";
import { api, type History } from "../../lib/api.ts";
import { useAsync } from "../../lib/useAsync.ts";
import { pct, usd } from "../../lib/format.ts";
import { basketSeries, dayLabel, firstValue, sampleIndices, type HistoryTable } from "../../lib/series.ts";
import { AreaChart } from "../../components/charts/AreaChart.tsx";
import { Segmented } from "../../components/Segmented.tsx";

type Weights = readonly { readonly symbol: string; readonly weight: number }[];

const RANGES = [
  { days: 30, label: "1M" },
  { days: 90, label: "3M" },
  { days: 365, label: "All" },
] as const;

const HEIGHT = 240;
const START_USD = 1_000;

export function PerformanceCard({
  weights,
  label,
  compare,
  compareLabel,
}: {
  weights: Weights;
  /** What the line is, in the legend: "This basket", "OpenAI". */
  label: string;
  /** A second, dotted line to measure it against, from the same start. */
  compare?: Weights | undefined;
  compareLabel?: string | undefined;
}) {
  const fetched = useAsync<History>((signal) => api.history(365, signal), []);
  // Today's value follows the live prices between fetches (lib/live.ts).
  const history = { ...fetched, data: useLivePrices(fetched.data, useMarket()) };
  const [range, setRange] = useState<number>(365);
  const model = useMemo(
    () => (history.data ? build(history.data, range, weights, compare) : null),
    [history.data, range, weights, compare],
  );
  const shownLast = useCountUp(model?.last ?? null);

  return (
    <section className="card perf-card">
      <div className="card-head">
        <div>
          <h2 className="card-title">What {usd(START_USD).replace(".00", "")} became</h2>
          <p className="card-sub">{model?.since ? `Put in on ${model.since}, worth today` : " "}</p>
        </div>
        {model && model.last !== null ? (
          <div className="hero-figure">
            <span className="num">{usd(shownLast)}</span>
            {model.change !== null ? (
              <span className={`num ${model.change >= 0 ? "up" : "down"}`}>{pct(model.change * 100)}</span>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="perf-bar">
        <div className="legend">
          <span>
            <i className="dot solid" /> {label}
          </span>
          {compareLabel && model?.secondary ? (
            <span>
              <i className="dot dotted" /> {compareLabel}
            </span>
          ) : null}
        </div>
        <Segmented
          label="Time range"
          options={RANGES.map((r) => ({ value: r.days, label: r.label }))}
          value={range}
          onChange={setRange}
        />
      </div>

      {model && model.days.length > 1 ? (
        <AreaChart
          days={model.days}
          primary={model.primary}
          secondary={model.secondary}
          primaryLabel={label}
          secondaryLabel={compareLabel}
          height={HEIGHT}
        />
      ) : (
        <div className="chart-empty" style={{ height: HEIGHT }}>
          {history.error ? (
            "Price history could not be loaded just now."
          ) : history.data ? (
            "Not enough price history yet."
          ) : (
            <>
              <span className="spin" /> Fetching prices…
            </>
          )}
        </div>
      )}
    </section>
  );
}

/** A basket's change over all the history there is, and the day it starts. */
export function growthOf(
  history: History,
  weights: Weights,
): { readonly change: number; readonly since: string } | null {
  const model = build(history, 365, weights, undefined);
  return model.change !== null && model.since ? { change: model.change, since: model.since } : null;
}

interface Model {
  readonly days: readonly string[];
  readonly primary: readonly (number | null)[];
  readonly secondary: readonly (number | null)[] | undefined;
  readonly last: number | null;
  readonly change: number | null;
  readonly since: string | null;
}

function build(history: History, range: number, weights: Weights, compare: Weights | undefined): Model {
  const start = Math.max(0, history.days.length - range);
  const prices: Record<string, (number | null)[]> = {};
  for (const [symbol, series] of Object.entries(history.prices)) prices[symbol] = series.slice(start);
  const table: HistoryTable = { days: history.days.slice(start), prices };

  // Start where most of the basket had a price, as the dashboard does: a
  // company that only began trading later cannot have been bought then.
  const from = startOf(table, weights);
  const primaryFull = basketSeries(table, weights, START_USD, from);
  const first = Math.max(0, firstValue(primaryFull));
  // The comparison starts on the first day it has prices for most of its
  // weight, at the main line's value on that day, so the two lines meet.
  // Starting earlier would renormalise it onto whatever was trading then and
  // could draw the main line twice.
  const secondaryFull = (() => {
    if (!compare?.length) return undefined;
    const from = Math.max(first, startOf(table, compare));
    const at = primaryFull[from];
    return at === null || at === undefined ? undefined : basketSeries(table, compare, at, from);
  })();

  // Thinned to a few dozen points, keeping the first and the last, so the
  // headline figures stay exact and a long range reads as a line.
  const kept = sampleIndices(table.days.length - first).map((i) => i + first);
  const pick = (series: readonly (number | null)[]) => kept.map((i) => series[i] ?? null);
  const primary = pick(primaryFull);
  const days = kept.map((i) => table.days[i]!);
  const firstValueSeen = primary.find((v) => v !== null) ?? null;
  const last = [...primary].reverse().find((v) => v !== null) ?? null;
  return {
    days,
    primary,
    secondary: secondaryFull ? pick(secondaryFull) : undefined,
    last,
    change: firstValueSeen && last !== null ? last / firstValueSeen - 1 : null,
    since: days.length ? dayLabel(days[0]!) : null,
  };
}

/** The first day on which companies making up most of a basket had a price. */
function startOf(table: HistoryTable, weights: Weights): number {
  const total = weights.reduce((sum, w) => sum + w.weight, 0) || 1;
  for (let i = 0; i < table.days.length; i++) {
    const covered = weights.reduce((sum, w) => sum + ((table.prices[w.symbol]?.[i] ?? null) !== null ? w.weight : 0), 0);
    if (covered / total >= 0.8) return i;
  }
  return 0;
}
